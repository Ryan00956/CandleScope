from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path
from collections.abc import Iterable, Sequence
from typing import Any, Callable, Mapping

from app.core.config import BacktestSettings
from app.data_engine.interval_policy import parse_interval_spec

from app.backtest.metrics_v2 import (
    BENCHMARK_MODEL,
    EQUITY_SAMPLING,
    METRICS_VERSION,
    build_market_context,
    parse_metrics_identity,
)
from app.backtest.reports import build_report
from app.backtest.trade_explanation import (
    RUN_COMPARE_SCHEMA,
    build_comparison_context,
    fingerprint_multiset_diff,
)
from app.backtest.strategy.protocol import StrategyProviderError
from app.backtest.strategy.python_bundle import (
    freeze_bundle,
    inspect_directory,
    inspect_zip,
)
from app.backtest.strategy.python_provider import PythonHostProvider
from app.backtest.strategy.python_runner import PythonRunnerError
from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation import (
    DualClockSimulationKernel,
    SimulationKernel,
    TradeSimulationKernel,
)
from app.simulation.trade_bar_builder import (
    BAR_BUILDER_REVISION,
    BAR_TIMEZONE,
    EXECUTION_CLOCK,
    SIGNAL_CLOCK,
    derive_complete_trade_bars,
)
from app.simulation.execution_realism import (
    BAR_FILL_POLICY_V2,
    EXECUTION_REALISM_V2,
    TRADE_FILL_POLICY_V2,
    parse_execution_realism,
)
from app.simulation.cost_sensitivity import build_cost_sensitivity_matrix

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
from .study_v2 import (
    HOLDOUT_RECEIPT_SCHEMA,
    OBJECTIVES,
    OOS_REPORT_SCHEMA,
    SELECTION_PROTOCOL_V2,
    STUDY_PROTOCOL_V2,
    STUDY_SCHEMA_V2,
    TIE_BREAK_V1,
    FoldSpecV2,
    build_holdout_receipt,
    build_oos_report,
    build_selection_receipt,
    evaluate_train_candidate,
    sample_candidates_v2,
    study_v2_identity,
    verify_oos_report,
    verify_holdout_receipt,
    verify_selection_receipt,
    walk_forward_folds_v2,
)
from .strategy.host_adapter import StrategyHostAdapter
from .strategy.host_policy import (
    HOST_POLICY_REVISION,
    HostPolicyConfig,
    PlanningContext,
)
from .strategy.protocol import StrategyProviderSession
from .strategy.pyne_adapter import PyneHostPlanner
from .strategy.registry import StrategyRevisionRegistry, build_default_strategy_registry
from .strategy.builtin import build_builtin_provider
from .strategy.chart_pyne import CHART_PYNE_REVISION, ChartPyneStrategyProvider
from .strategy.pine_adapter import PineStrategyProvider
from .strategy.workspace import compile_revision
from .strategy.python_basket import (
    BASKET_PROTOCOL_V1,
    build_basket_robustness,
    normalize_basket,
    plan_independent_runs,
)

FIDELITY_MATRIX = {
    "BAR_APPROX": ("BAR", "APPROXIMATE"),
    "TRADE_TAPE": ("RAW_TRADE", "TRADE_SEQUENCE"),
    "AGG_TRADE_TAPE": ("AGG_TRADE", "AGGREGATED_TRADE_SEQUENCE"),
    "AGG_TRADE_EXECUTION": ("AGG_TRADE", "AGGREGATED_TRADE_SEQUENCE"),
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
        fault_injector: Callable[[str, Mapping[str, object]], None] | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.strategy_registry = strategy_registry or build_default_strategy_registry()
        self.enforce_registered_revisions = enforce_registered_revisions
        # Test-only seam. Production construction never supplies an injector.
        self._fault_injector = fault_injector
        self._audit_ordinals: dict[str, int] = {}

    @classmethod
    def start(
        cls,
        settings: BacktestSettings,
        *,
        now_ms: int | None = None,
        strategy_registry: StrategyRevisionRegistry | None = None,
        enforce_registered_revisions: bool = False,
        fault_injector: Callable[[str, Mapping[str, object]], None] | None = None,
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
            fault_injector,
        )

    def shutdown(self) -> None:
        self.repository.close()

    def capabilities(self) -> dict[str, object]:
        from .quick_presets import list_quick_presets

        fidelity_modes: list[str] = []
        if self.settings.bar_effective:
            fidelity_modes.append("BAR_APPROX")
        if self.settings.trade_tape_effective:
            fidelity_modes.append("AGG_TRADE_TAPE")
            fidelity_modes.append("AGG_TRADE_EXECUTION")
        if self.settings.book_assisted_effective:
            fidelity_modes.append("BOOK_ASSISTED")
        return {
            "engine_version": ENGINE_VERSION,
            "schema_version": SCHEMA_VERSION,
            "account_model": "LINEAR_PERP_ONE_WAY_V1",
            "account_models": ["LINEAR_PERP_ONE_WAY_V1", "LINEAR_PERP_ONE_WAY_V2"],
            "funding_modes_v2": ["OFF", "FIXED_SCENARIO", "HISTORICAL_REQUIRED"],
            "host_policy_revision": HOST_POLICY_REVISION,
            "sizing_policies": [
                "FIXED_QTY_V1",
                "FIXED_NOTIONAL_V1",
                "EQUITY_PERCENT_V1",
                "RISK_PER_STOP_V1",
            ],
            "provider_protocol": "strategy-provider/1",
            "flags": {
                "BACKTEST_ENABLED": self.settings.enabled,
                "BACKTEST_BAR_ENABLED": self.settings.bar_enabled,
                "BACKTEST_CHART_CONTEXT_ENABLED": self.settings.chart_context_enabled,
                "BACKTEST_TRADE_EXPLANATION_ENABLED": self.settings.trade_explanation_enabled,
                "BACKTEST_TRADE_TAPE_ENABLED": self.settings.trade_tape_enabled,
                "BACKTEST_STUDY_ENABLED": self.settings.study_enabled,
                "BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED": self.settings.replay_review_bridge_enabled,
                "BACKTEST_PYTHON_STRATEGY_ENABLED": os.environ.get(
                    "BACKTEST_PYTHON_STRATEGY_ENABLED", "0"
                ).strip()
                == "1",
                "BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED": os.environ.get(
                    "BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "0"
                ).strip()
                == "1",
                "BACKTEST_PYTHON_SCALE_V1_ENABLED": os.environ.get(
                    "BACKTEST_PYTHON_SCALE_V1_ENABLED", "0"
                ).strip()
                == "1",
            },
            "fidelity_modes": fidelity_modes,
            "chart_context": {
                "schema_version": "candlescope.backtest-chart-context/1",
                "enabled": self.settings.chart_context_effective,
                "resolve_is_local_only": True,
                "materialize_requires_confirmation": True,
            },
            "quick_presets": list_quick_presets(),
            "strategy_revisions": self.strategy_registry.revision_ids(),
            "strategies": self.strategy_registry.descriptors()
            + [
                self._revision_wire(item)
                for item in self.repository.list_strategy_revisions()
            ],
        }

    def _revision_wire(self, row: Mapping[str, object]) -> dict[str, object]:
        capabilities = json.loads(str(row["capabilities_json"]))
        return {
            "revision_id": row["revision_id"],
            "provider_kind": row["language"],
            "label": row["name"],
            "description": f"不可变 {row['schema_version']} · {row['compiled_hash']}",
            "input_modes": capabilities["input_modes"],
            "output_modes": capabilities["output_modes"],
            "signal_clock": capabilities["signal_clock"],
            "required_features": capabilities.get("required_features") or [],
            "warmup_requirement": capabilities.get("warmup_requirement") or {},
            "parameter_schema": json.loads(str(row["parameter_schema_json"])),
            "accepts_source": False,
            "unsupported": capabilities["unsupported"],
            "source_hash": row["source_hash"],
            "compiled_hash": row["compiled_hash"],
            "runtime_revision": row["runtime_revision"],
            "archived_at_ms": row["archived_at_ms"],
        }

    def create_strategy_revision(
        self, payload: Mapping[str, object], *, now_ms: int | None = None
    ) -> dict[str, object]:
        stamp = now_ms or _now_ms()
        try:
            record = compile_revision(payload, now_ms=stamp)
        except StrategyProviderError as exc:
            raise BacktestError(
                exc.code,
                str(exc),
                details={"next_step": "fix the located source error and compile again"},
            ) from exc
        if bool(payload.get("_force_new_revision")):
            self.repository.insert_strategy_revision(record)
            persisted, inserted = record, True
        else:
            persisted, inserted = self.repository.get_or_insert_strategy_revision(
                record
            )
        return {
            **self._revision_wire(persisted),
            "schema_version": persisted["schema_version"],
            "base_revision_id": persisted["base_revision_id"],
            "diagnostics": record["diagnostics"],
            "reused": not inserted,
        }

    def inspect_python_strategy_bundle(
        self,
        *,
        zip_bytes: bytes | None = None,
        directory: str | None = None,
    ) -> dict[str, object]:
        try:
            inspected = (
                inspect_zip(zip_bytes)
                if zip_bytes is not None
                else inspect_directory(Path(str(directory)))
            )
        except StrategyProviderError as exc:
            raise BacktestError(exc.code, str(exc)) from exc
        return {
            "bundle_hash": inspected["bundle_hash"],
            "manifest_hash": inspected["manifest_hash"],
            "source_hash": inspected["source_hash"],
            "requirements_lock_hash": inspected["requirements_lock_hash"],
            "sdk_hash": inspected["sdk_hash"],
            "capability_hash": inspected["capability_hash"],
            "parameter_schema_hash": inspected["parameter_schema_hash"],
            "manifest": inspected["manifest"],
            "diagnostics": inspected["diagnostics"],
            "size_bytes": inspected["size_bytes"],
            "file_count": inspected["file_count"],
        }

    def create_python_strategy_bundle(
        self,
        *,
        zip_bytes: bytes | None = None,
        directory: str | None = None,
        now_ms: int | None = None,
    ) -> dict[str, object]:
        from pathlib import Path

        stamp = now_ms or _now_ms()
        try:
            inspected = (
                inspect_zip(zip_bytes)
                if zip_bytes is not None
                else inspect_directory(Path(str(directory)))
            )
        except StrategyProviderError as exc:
            raise BacktestError(exc.code, str(exc)) from exc
        existing = self.repository.get_strategy_bundle_by_hash(inspected["bundle_hash"])
        if existing is not None:
            return self._bundle_wire(existing)
        bundle_id = "psb_" + uuid.uuid4().hex
        store_root = (
            self.settings.db_path.parent / "python-strategy-bundles" / bundle_id
        )
        freeze_bundle(inspected, store_root)
        record = {
            "bundle_id": bundle_id,
            "bundle_hash": inspected["bundle_hash"],
            "manifest_hash": inspected["manifest_hash"],
            "source_hash": inspected["source_hash"],
            "requirements_lock_hash": inspected["requirements_lock_hash"],
            "sdk_hash": inspected["sdk_hash"],
            "capability_hash": inspected["capability_hash"],
            "parameter_schema_hash": inspected["parameter_schema_hash"],
            "size_bytes": inspected["size_bytes"],
            "file_count": inspected["file_count"],
            "store_path": str(store_root),
            "manifest_json": json.dumps(
                inspected["manifest"], sort_keys=True, separators=(",", ":")
            ),
            "created_at_ms": stamp,
        }
        self.repository.insert_strategy_bundle(record)
        return self._bundle_wire(record)

    def get_python_strategy_bundle(self, bundle_id: str) -> dict[str, object]:
        row = self.repository.get_strategy_bundle(bundle_id)
        if row is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown bundle {bundle_id}")
        return self._bundle_wire(row)

    def build_python_host_provider(
        self,
        revision_id: str,
        *,
        parameters: Mapping[str, Any] | None = None,
        mode: str = "SANDBOXED_LOCAL",
        trusted_confirmed: bool = False,
    ) -> PythonHostProvider:
        row = self.repository.get_strategy_revision(revision_id)
        if row is None or row["base_revision_id"] != "python-source-v1":
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "select a frozen PYTHON_SOURCE revision"
            )
        try:
            identity = json.loads(str(row["source_text"]))
        except json.JSONDecodeError as exc:
            raise BacktestError(
                "PROVIDER_PROTOCOL_VIOLATION", "PYTHON_SOURCE identity must be JSON"
            ) from exc
        bundle = self.repository.get_strategy_bundle(
            str(identity.get("bundle_id") or "")
        )
        if bundle is None:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "python revision is missing its frozen bundle"
            )
        return PythonHostProvider(
            Path(str(bundle["store_path"])),
            entrypoint=str(identity.get("entrypoint") or "strategy:Strategy"),
            parameters=dict(parameters or {}),
            mode=str(mode or "SANDBOXED_LOCAL"),
            trusted_confirmed=bool(trusted_confirmed),
        )

    def get_python_runtime_receipt(self, revision_id: str) -> dict[str, object]:
        row = self.repository.get_strategy_revision(revision_id)
        if row is None or row["base_revision_id"] != "python-source-v1":
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "select a frozen PYTHON_SOURCE revision"
            )
        identity = json.loads(str(row["source_text"]))
        bundle = self.repository.get_strategy_bundle(
            str(identity.get("bundle_id") or "")
        )
        smoke = self.repository.latest_strategy_smoke(revision_id)
        smoke_details = (
            json.loads(str(smoke["details_json"])) if smoke is not None else None
        )
        return {
            "revisionId": revision_id,
            "bundleId": identity.get("bundle_id"),
            "bundleHash": identity.get("bundle_hash"),
            "entrypoint": identity.get("entrypoint"),
            "signalClock": identity.get("signalClock"),
            "mode": (smoke_details or {}).get("runtimeMode") or "SANDBOXED_LOCAL",
            "storePath": None if bundle is None else bundle["store_path"],
            "smoke": smoke_details,
        }

    def create_python_strategy_revision(
        self, bundle_id: str, *, now_ms: int | None = None
    ) -> dict[str, object]:
        bundle = self.repository.get_strategy_bundle(bundle_id)
        if bundle is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown bundle {bundle_id}")
        manifest = json.loads(str(bundle["manifest_json"]))
        identity = {
            "bundle_id": bundle["bundle_id"],
            "bundle_hash": bundle["bundle_hash"],
            "manifest_hash": bundle["manifest_hash"],
            "source_hash": bundle["source_hash"],
            "sdk_hash": bundle["sdk_hash"],
            "entrypoint": manifest.get("entrypoint"),
            "signalClock": manifest.get("signalClock"),
            "outputModes": manifest.get("outputModes") or ["TARGET_POSITION"],
            "requiredFeatures": manifest.get("requiredFeatures") or [],
            "warmup": manifest.get("warmup") or {},
        }
        return self.create_strategy_revision(
            {
                "name": manifest.get("name") or bundle_id,
                "language": "PYTHON_SOURCE",
                "source_text": json.dumps(
                    identity, sort_keys=True, separators=(",", ":")
                ),
                "parameter_schema": manifest.get("parameters") or [],
            },
            now_ms=now_ms,
        )

    def _bundle_wire(self, row: Mapping[str, Any]) -> dict[str, object]:
        return {
            "bundle_id": row["bundle_id"],
            "bundle_hash": row["bundle_hash"],
            "manifest_hash": row["manifest_hash"],
            "source_hash": row["source_hash"],
            "requirements_lock_hash": row["requirements_lock_hash"],
            "sdk_hash": row["sdk_hash"],
            "capability_hash": row["capability_hash"],
            "parameter_schema_hash": row["parameter_schema_hash"],
            "size_bytes": row["size_bytes"],
            "file_count": row["file_count"],
            "created_at_ms": row["created_at_ms"],
        }

    def copy_strategy_revision(
        self, revision_id: str, *, name: str, now_ms: int | None = None
    ) -> dict[str, object]:
        source = self.repository.get_strategy_revision(revision_id)
        if source is None:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", f"unknown strategy revision {revision_id}"
            )
        return self.create_strategy_revision(
            {
                "name": name,
                "language": source["language"],
                "base_revision_id": source["base_revision_id"],
                "source_text": source["source_text"],
                "parameter_schema": json.loads(str(source["parameter_schema_json"])),
                "_force_new_revision": True,
            },
            now_ms=now_ms,
        )

    def archive_strategy_revision(
        self, revision_id: str, *, now_ms: int | None = None
    ) -> dict[str, object]:
        stamp = now_ms or _now_ms()
        if not self.repository.archive_strategy_revision(revision_id, stamp):
            raise BacktestError(
                "IDENTITY_MUTATION", "revision is unknown or already archived"
            )
        row = self.repository.get_strategy_revision(revision_id)
        assert row is not None
        return self._revision_wire(row)

    def smoke_strategy_revision(
        self,
        revision_id: str,
        payload: Mapping[str, object],
        *,
        now_ms: int | None = None,
    ) -> dict[str, object]:
        row = self.repository.get_strategy_revision(revision_id)
        if row is None or row["archived_at_ms"] is not None:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "select an active compiled revision first"
            )
        start, end = (
            int(payload.get("start_time_ms") or 0),
            int(payload.get("end_time_ms") or 0),
        )
        if end <= start or end - start > 7 * 86_400_000:
            raise BacktestError(
                "BUDGET_EXCEEDED",
                "smoke window must be positive and no longer than 7 days",
            )
        runtime_mode = str(payload.get("python_runtime_mode") or "SANDBOXED_LOCAL")
        trusted_confirmed = bool(payload.get("python_trusted_confirmed"))
        provider: Any = None
        try:
            if row["base_revision_id"] == "python-source-v1":
                provider = self.build_python_host_provider(
                    revision_id,
                    parameters=dict(payload.get("parameters") or {}),
                    mode=runtime_mode,
                    trusted_confirmed=trusted_confirmed,
                )
                provider.prepare(
                    {
                        "run_id": "smoke",
                        "revision_id": revision_id,
                        "parameters": dict(payload.get("parameters") or {}),
                    }
                )
            else:
                provider = (
                    ChartPyneStrategyProvider()
                    if row["base_revision_id"] == CHART_PYNE_REVISION
                    else (
                        PineStrategyProvider()
                        if row["base_revision_id"] == "pine-long-flat-v1"
                        else build_builtin_provider(str(row["base_revision_id"]))
                    )
                )
                compiled = json.loads(str(row["compiled_json"]))
                provider.prepare(
                    {
                        "roles": ["BARS"],
                        "source": compiled.get("executionSource", row["source_text"]),
                        "parameters": dict(payload.get("parameters") or {}),
                        "outputMode": (
                            json.loads(str(row["capabilities_json"]))["output_modes"][
                                -1
                            ]
                        ),
                    }
                )
        except PythonRunnerError as exc:
            next_step = (
                "SANDBOXED_LOCAL failed closed; confirm TRUSTED_LOCAL permission facts if that flag is enabled"
                if exc.code == "SANDBOX_UNAVAILABLE"
                else "fix the source or runtime mode and rerun smoke"
            )
            raise BacktestError(
                exc.code,
                str(exc),
                details={"next_step": next_step},
            ) from exc
        except StrategyProviderError as exc:
            raise BacktestError(
                exc.code,
                str(exc),
                details={"next_step": "correct parameters/source and rerun smoke"},
            ) from exc
        finally:
            if provider is not None:
                provider.close()
        stamp = now_ms or _now_ms()
        details = {
            "schema": "STRATEGY_SMOKE_V1",
            "revisionId": revision_id,
            "datasetId": str(payload.get("dataset_id") or ""),
            "snapshotHash": str(payload.get("snapshot_hash") or ""),
            "startTimeMs": start,
            "endTimeMs": end,
            "status": "PASSED",
            "runtimeMode": (
                runtime_mode if row["base_revision_id"] == "python-source-v1" else None
            ),
        }
        receipt_hash = "sha256:" + sha256_hex(canonical_json(details))
        self.repository.insert_strategy_smoke(
            {
                "receipt_hash": receipt_hash,
                "revision_id": revision_id,
                "dataset_id": details["datasetId"],
                "snapshot_hash": details["snapshotHash"],
                "start_time_ms": start,
                "end_time_ms": end,
                "status": "PASSED",
                "details_json": canonical_json(details),
                "created_at_ms": stamp,
            }
        )
        return {**details, "receiptHash": receipt_hash}

    def get_signal_trace(
        self, run_id: str, *, after: int = 0, limit: int = 200
    ) -> dict[str, object]:
        self.get_run(run_id)
        bounded = min(500, max(1, int(limit)))
        rows = self.repository.list_signal_trace(
            run_id, after=max(0, int(after)), limit=bounded + 1
        )
        page = rows[:bounded]
        return {
            "schema": "SIGNAL_TRACE_V1",
            "runId": run_id,
            "items": page,
            "nextAfter": page[-1]["ordinal"] if len(rows) > bounded and page else None,
            "limit": bounded,
        }

    def compare_run_pair(
        self, left_run_id: str, right_run_id: str
    ) -> dict[str, object]:
        left_run, right_run = self.get_run(left_run_id), self.get_run(right_run_id)
        left_report, right_report = self.repository.get_reports_for_compare(
            left_run_id, right_run_id
        )
        if left_report is None or right_report is None:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "both Runs must be completed before comparison"
            )
        left_config, right_config = (
            json.loads(str(left_run["config_json"])),
            json.loads(str(right_run["config_json"])),
        )

        def context_for(
            run: Mapping[str, object],
            config: Mapping[str, object],
            report: Mapping[str, object],
        ) -> dict[str, object]:
            stored = report.get("comparison_context")
            if isinstance(stored, Mapping):
                return dict(stored)
            revision = self.repository.get_strategy_revision(
                str(run["strategy_revision_id"])
            )
            return build_comparison_context(
                run=run,
                config=config,
                provider_identity={},
                revision=revision,
            )

        left_context = context_for(left_run, left_config, left_report)
        right_context = context_for(right_run, right_config, right_report)
        compatible = (
            left_context.get("complete") is True
            and right_context.get("complete") is True
            and bool(left_context.get("contextHash"))
            and (left_context.get("contextHash") == right_context.get("contextHash"))
        )
        left_context_value = left_context.get("context")
        right_context_value = right_context.get("context")
        context_keys = sorted(
            set(
                (left_context_value or {}).keys()
                if isinstance(left_context_value, Mapping)
                else ()
            )
            | set(
                (right_context_value or {}).keys()
                if isinstance(right_context_value, Mapping)
                else ()
            )
        )
        mismatches = sorted(
            set(
                [
                    name
                    for name in context_keys
                    if (
                        (left_context_value or {}).get(name)  # type: ignore[union-attr]
                        != (right_context_value or {}).get(name)  # type: ignore[union-attr]
                    )
                ]
                + list(left_context.get("missingFields") or [])
                + list(right_context.get("missingFields") or [])
            )
        )
        hashes_left, hashes_right = (
            left_report.get("hashes", {}),
            right_report.get("hashes", {}),
        )
        explanation = None
        if hashes_left.get("decision") == hashes_right.get(
            "decision"
        ) and hashes_left.get("fill") != hashes_right.get("fill"):
            explanation = "决策相同但成交 hash 不同：执行时钟、延迟、滑点或费用精度改变了成交；不得把近似成交视为逐笔精确。"
        params_left, params_right = (
            left_config.get("parameters", {}),
            right_config.get("parameters", {}),
        )
        parameter_diff = {
            key: {"left": params_left.get(key), "right": params_right.get(key)}
            for key in sorted(set(params_left) | set(params_right))
            if params_left.get(key) != params_right.get(key)
        }
        left_performance = dict(left_report.get("performance") or {})
        right_performance = dict(right_report.get("performance") or {})

        def metric_value(
            container: Mapping[str, object], section: str, key: str
        ) -> object:
            raw = (container.get(section) or {}).get(key)  # type: ignore[union-attr]
            return raw.get("value") if isinstance(raw, Mapping) else raw

        def decimal_diff(left: object, right: object) -> dict[str, object]:
            result: dict[str, object] = {"left": left, "right": right, "delta": None}
            if compatible and left is not None and right is not None:
                try:
                    result["delta"] = str(Decimal(str(right)) - Decimal(str(left)))
                except InvalidOperation:
                    pass
            return result

        trade_diff = {
            "tradeCount": decimal_diff(
                metric_value(left_performance, "trading", "trade_count")
                or left_report.get("metrics", {}).get("trade_count"),
                metric_value(right_performance, "trading", "trade_count")
                or right_report.get("metrics", {}).get("trade_count"),
            ),
            "netPnl": decimal_diff(
                metric_value(left_performance, "returns", "net_pnl")
                or left_report.get("metrics", {}).get("realized_net_pnl"),
                metric_value(right_performance, "returns", "net_pnl")
                or right_report.get("metrics", {}).get("realized_net_pnl"),
            ),
            "maxDrawdown": decimal_diff(
                metric_value(left_performance, "risk", "max_drawdown"),
                metric_value(right_performance, "risk", "max_drawdown"),
            ),
        }
        cost_diff = {
            key: decimal_diff(
                metric_value(left_performance, "execution", key),
                metric_value(right_performance, "execution", key),
            )
            for key in ("fees", "funding", "slippage")
        }
        left_alignment = bool(
            (left_report.get("trade_explanation") or {}).get("tradeAlignmentAvailable")
        )
        right_alignment = bool(
            (right_report.get("trade_explanation") or {}).get("tradeAlignmentAvailable")
        )
        fingerprint_diff: dict[str, object]
        if compatible and left_alignment and right_alignment:
            fingerprint_diff = fingerprint_multiset_diff(
                list(left_report.get("trades") or []),
                list(right_report.get("trades") or []),
            )
            fingerprint_diff["available"] = True
        else:
            fingerprint_diff = {
                "version": "TRADE_FINGERPRINT_V2",
                "available": False,
                "reason": (
                    "COMPARISON_CONTEXT_MISMATCH"
                    if not compatible
                    else "TRADE_ALIGNMENT_UNAVAILABLE"
                ),
                "addedCount": None,
                "removedCount": None,
                "unchangedCount": None,
                "added": [],
                "removed": [],
            }
        return {
            "schema": RUN_COMPARE_SCHEMA,
            "directComparisonAllowed": compatible,
            "incompatibleFields": mismatches,
            "comparisonContext": {
                "leftHash": left_context.get("contextHash"),
                "rightHash": right_context.get("contextHash"),
            },
            "precisionExplanation": explanation,
            "parameterDiff": parameter_diff,
            "tradeDiff": trade_diff,
            "costDiff": cost_diff,
            "fingerprintDiff": fingerprint_diff,
            "left": {
                "runId": left_run_id,
                "hashes": hashes_left,
                "equity": left_report.get("equity_curve", []),
                "equityDaily": left_performance.get("equity_daily", []),
                "drawdownDaily": left_performance.get("drawdown_daily", []),
                "metrics": left_report.get("metrics", {}),
            },
            "right": {
                "runId": right_run_id,
                "hashes": hashes_right,
                "equity": right_report.get("equity_curve", []),
                "equityDaily": right_performance.get("equity_daily", []),
                "drawdownDaily": right_performance.get("drawdown_daily", []),
                "metrics": right_report.get("metrics", {}),
            },
        }

    def compare_recent_compatible_run(self, run_id: str) -> dict[str, object]:
        current = self.get_run(run_id)
        current_report, _ = self.repository.get_reports_for_compare(run_id, run_id)
        if current_report is None:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "Run must be completed before comparison"
            )
        current_config = json.loads(str(current["config_json"]))
        current_context = current_report.get("comparison_context")
        if not isinstance(current_context, Mapping):
            current_context = build_comparison_context(
                run=current,
                config=current_config,
                provider_identity={},
                revision=self.repository.get_strategy_revision(
                    str(current["strategy_revision_id"])
                ),
            )
        current_hash = (
            current_context.get("contextHash")
            if current_context.get("complete") is True
            else None
        )
        baseline_id: str | None = None
        current_created = int(current.get("created_at_ms") or 0)
        for candidate in self.repository.list_runs():
            candidate_id = str(candidate.get("run_id") or "")
            if (
                not candidate_id
                or candidate_id == run_id
                or candidate.get("state") != RunState.COMPLETED.value
                or int(candidate.get("created_at_ms") or 0) > current_created
            ):
                continue
            candidate_report, _ = self.repository.get_reports_for_compare(
                candidate_id, candidate_id
            )
            if candidate_report is None:
                continue
            candidate_context = candidate_report.get("comparison_context")
            if not isinstance(candidate_context, Mapping):
                candidate_context = build_comparison_context(
                    run=candidate,
                    config=json.loads(str(candidate["config_json"])),
                    provider_identity={},
                    revision=self.repository.get_strategy_revision(
                        str(candidate["strategy_revision_id"])
                    ),
                )
            if (
                current_hash
                and candidate_context.get("complete") is True
                and candidate_context.get("contextHash") == current_hash
            ):
                baseline_id = candidate_id
                break
        return {
            "schema": "RUN_COMPARE_RECENT_V1",
            "currentRunId": run_id,
            "baselineRunId": baseline_id,
            "comparison": (
                None
                if baseline_id is None
                else self.compare_run_pair(baseline_id, run_id)
            ),
        }

    def clone_run_parameter(
        self, run_id: str, *, parameter: str, value: object, idempotency_key: str
    ) -> dict[str, object]:
        origin = self.get_run(run_id)
        config = json.loads(str(origin["config_json"]))
        parameters = dict(config.get("parameters") or {})
        if parameter not in parameters:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD",
                "clone parameter must already exist in the frozen Run",
            )
        if parameters[parameter] == value:
            raise BacktestError(
                "IDENTITY_MUTATION", "clone must change exactly one parameter"
            )
        parameters[parameter] = value
        config["parameters"] = parameters
        config.pop("study_id", None)
        return self.create_run(config, idempotency_key=idempotency_key)

    def create_review_bridge(
        self, run_id: str, payload: Mapping[str, object], *, now_ms: int | None = None
    ) -> dict[str, object]:
        if not self.settings.replay_review_bridge_enabled:
            raise BacktestError(
                "FLAG_DISABLED",
                "BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED is 0; enable it explicitly for research review",
            )
        run = self.get_run(run_id)
        if run["state"] != "COMPLETED":
            raise BacktestError(
                "IDENTITY_MUTATION",
                "complete the source Run before creating a review bridge",
            )
        start, end = (
            int(payload.get("start_time_ms") or 0),
            int(payload.get("end_time_ms") or 0),
        )
        config = json.loads(str(run["config_json"]))
        if (
            start < int(config["start_time_ms"])
            or end > int(config["end_time_ms"])
            or end <= start
        ):
            raise BacktestError(
                "DATA_QUALITY_FAILED",
                "review window must be inside the immutable source Run",
            )
        bridge_id, stamp = "btrb_" + uuid.uuid4().hex, now_ms or _now_ms()
        dataset_ref = {
            key: run[key] for key in ("dataset_id", "data_epoch", "snapshot_hash")
        }
        projection = {
            "strategy_revision_id": run["strategy_revision_id"],
            "config_hash": run["config_hash"],
            "report_hash": self.get_report(run_id)["hashes"]["report"],
        }
        self.repository.insert_review_bridge(
            {
                "bridge_id": bridge_id,
                "schema_version": "REPLAY_RESEARCH_BRIDGE_V1",
                "run_id": run_id,
                "dataset_ref_json": canonical_json(dataset_ref),
                "window_json": canonical_json(
                    {"start_time_ms": start, "end_time_ms": end}
                ),
                "strategy_projection_json": canonical_json(projection),
                "training_run_id": None,
                "state": "BLINDED",
                "reveal_json": None,
                "created_at_ms": stamp,
            }
        )
        return {
            "bridgeId": bridge_id,
            "schema": "REPLAY_RESEARCH_BRIDGE_V1",
            "state": "BLINDED",
            "datasetRef": dataset_ref,
            "window": {"start_time_ms": start, "end_time_ms": end},
            "strategyProjection": None,
            "isolation": {
                "shared": ["immutable dataset ref", "read-only projection"],
                "notShared": ["account", "cursor", "checkpoint", "UI store"],
            },
        }

    def bind_review_bridge_training_run(
        self, bridge_id: str, training_run_id: str
    ) -> dict[str, object]:
        self.repository.bind_review_bridge_training_run(bridge_id, training_run_id)
        return self.get_review_bridge(bridge_id)

    def get_review_bridge(self, bridge_id: str) -> dict[str, object]:
        row = self.repository.get_review_bridge(bridge_id)
        if row is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "review bridge does not exist")
        revealed = str(row["state"]) == "REVEALED"
        return {
            "bridgeId": str(row["bridge_id"]),
            "schema": str(row["schema_version"]),
            "state": str(row["state"]),
            "runId": str(row["run_id"]),
            "trainingRunId": row["training_run_id"],
            "datasetRef": json.loads(str(row["dataset_ref_json"])),
            "window": json.loads(str(row["window_json"])),
            "strategyProjection": (
                json.loads(str(row["strategy_projection_json"])) if revealed else None
            ),
            "comparison": (json.loads(str(row["reveal_json"])) if revealed else None),
            "isolation": {
                "shared": ["immutable dataset ref", "read-only projection"],
                "notShared": ["account", "cursor", "checkpoint", "UI store"],
            },
        }

    def reveal_review_bridge(
        self,
        bridge_id: str,
        *,
        training_run_id: str,
        training_state: str,
        human_results: Mapping[str, object],
        now_ms: int | None = None,
    ) -> dict[str, object]:
        row = self.repository.get_review_bridge(bridge_id)
        if row is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "review bridge does not exist")
        if str(row.get("training_run_id") or "") != training_run_id:
            raise BacktestError(
                "IDENTITY_MUTATION", "TrainingRun identity does not match bridge"
            )
        if str(row["state"]) == "REVEALED":
            return self.get_review_bridge(bridge_id)
        if training_state != "ENDED":
            raise BacktestError(
                "IDENTITY_MUTATION", "blind review must reach ENDED before reveal"
            )
        strategy_projection = json.loads(str(row["strategy_projection_json"]))
        human_projection = {
            "schema_version": human_results.get("schema_version"),
            "summary": human_results.get("summary"),
            "items": list(human_results.get("items") or []),
            "returned_count": human_results.get("returned_count"),
            "truncated": human_results.get("truncated"),
        }
        reveal = {
            "schema": "REPLAY_RESEARCH_REVEAL_V1",
            "revealedAtMs": now_ms or _now_ms(),
            "trainingRunId": training_run_id,
            "strategyOrders": strategy_projection,
            "humanOrders": human_projection,
            "humanProjectionHash": "sha256:"
            + sha256_hex(canonical_json(human_projection)),
            "precision": "read-only research comparison; accounts and execution state remain independent",
        }
        try:
            self.repository.reveal_review_bridge(bridge_id, canonical_json(reveal))
        except RuntimeError as exc:
            raise BacktestError("IDENTITY_MUTATION", str(exc)) from exc
        return self.get_review_bridge(bridge_id)

    def validate_run(self, payload: Mapping[str, object]) -> dict[str, object]:
        identity = self._identity_from_payload(payload)
        self._assert_flags(identity.fidelity_mode)
        self._assert_active_budget()
        result: dict[str, object] = {
            "ok": True,
            "config_hash": config_hash(identity),
            "fidelity_mode": identity.fidelity_mode,
            "source_event_kind": identity.source_event_kind,
            "engine_version": identity.engine_version,
        }
        if identity.fidelity_mode == "AGG_TRADE_EXECUTION":
            result.update(
                {
                    "signal_clock": identity.signal_clock,
                    "signal_interval": identity.signal_interval,
                    "execution_clock": identity.execution_clock,
                    "bar_builder": identity.bar_builder,
                    "timezone": identity.timezone,
                }
            )
        return result

    def create_run(
        self,
        payload: Mapping[str, object],
        *,
        idempotency_key: str,
        now_ms: int | None = None,
        enforce_active_budget: bool = True,
    ) -> dict[str, object]:
        if not idempotency_key.strip():
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "idempotency key is required")
        existing = self.repository.get_run_by_idempotency(idempotency_key)
        if existing is not None:
            return existing
        identity = self._identity_from_payload(payload)
        self._assert_flags(identity.fidelity_mode)
        if enforce_active_budget:
            self._assert_active_budget()
        stamp = now_ms or _now_ms()
        digest = config_hash(identity)
        run_id = f"bt_{uuid.uuid4().hex}"
        stored_payload = dict(payload)
        normalized_execution = json.loads(identity.execution_json)
        stored_payload["strategy_source"] = normalized_execution.get("strategy_source")
        if normalized_execution.get("strategy_execution_revision"):
            stored_payload["strategy_execution_revision"] = normalized_execution[
                "strategy_execution_revision"
            ]
        if normalized_execution.get("signal_trace_mode"):
            stored_payload["signal_trace_mode"] = normalized_execution[
                "signal_trace_mode"
            ]
        if normalized_execution.get("host_policy_revision"):
            stored_payload.update(
                {
                    name: normalized_execution.get(name)
                    for name in (
                        "host_policy_revision",
                        "sizing_policy",
                        "risk_policy",
                        "fixed_qty",
                        "fixed_notional",
                        "equity_percent",
                        "risk_per_stop_percent",
                        "stop_distance",
                        "max_abs_position_qty",
                        "max_notional",
                        "max_leverage",
                        "max_order_risk",
                        "max_active_orders",
                        "max_cumulative_fees",
                        "max_drawdown_percent",
                        "daily_loss_limit",
                        "cooldown_events",
                    )
                }
            )
        if normalized_execution.get("execution_model_revision"):
            stored_payload.update(
                {
                    name: normalized_execution.get(name)
                    for name in (
                        "execution_model_revision",
                        "fill_policy",
                        "participation_rate",
                        "latency_ms",
                        "latency_events",
                        "order_end_policy",
                        "bar_path_scenario",
                        "tif_supported",
                        "equity_curve_event_interval",
                    )
                }
            )
        if normalized_execution.get("metrics_version"):
            stored_payload.update(
                {
                    name: normalized_execution.get(name)
                    for name in (
                        "report_schema",
                        "metrics_version",
                        "equity_sampling",
                        "equity_curve_mode",
                        "annualization_days",
                        "risk_free_rate_annual",
                        "benchmark_model",
                        "sample_role",
                    )
                }
            )
        if identity.fidelity_mode == "AGG_TRADE_EXECUTION":
            stored_payload.update(
                {
                    "signal_clock": identity.signal_clock,
                    "signal_interval": identity.signal_interval,
                    "execution_clock": identity.execution_clock,
                    "bar_builder": identity.bar_builder,
                    "timezone": identity.timezone,
                }
            )
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
            "config_json": canonical_json(stored_payload),
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
            raise BacktestError(
                "RUN_CAPACITY_EXCEEDED",
                "active run ceiling reached",
                details={
                    "retryable": True,
                    "retry_after_ms": 1000,
                    "capacity": "active",
                },
            )
        if inserted == "QUEUE_LIMIT":
            raise BacktestError(
                "RUN_CAPACITY_EXCEEDED",
                "queued run ceiling reached",
                details={
                    "retryable": True,
                    "retry_after_ms": 1000,
                    "capacity": "queued",
                },
            )
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
        if (
            expected_generation is not None
            and int(record["generation"]) != expected_generation
        ):
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

    def resume_failed_run(
        self, run_id: str, *, now_ms: int | None = None
    ) -> dict[str, object]:
        """Resume a recoverable Provider/storage failure from a verified V2 checkpoint."""
        record = self.get_run(run_id)
        if RunState(record["state"]) != RunState.FAILED:
            raise BacktestError("RECOVERY_NOT_ALLOWED", "run is not failed")
        if str(record.get("failure_code") or "") not in {
            "PROVIDER_TIMEOUT",
            "PROVIDER_CRASH_UNRECOVERABLE",
            "BACKTEST_STORAGE_TRANSIENT",
        }:
            raise BacktestError(
                "RECOVERY_NOT_ALLOWED", "failure class is not checkpoint-recoverable"
            )
        checkpoint = self.repository.latest_checkpoint(run_id)
        if checkpoint is None:
            raise BacktestError(
                "RECOVERY_NOT_ALLOWED", "no durable checkpoint is available"
            )
        payload = self._verified_checkpoint_payload(record, checkpoint)
        if payload.get("schemaVersion") != "candlescope.backtest-checkpoint/2":
            raise BacktestError(
                "RECOVERY_NOT_ALLOWED", "legacy checkpoint has no recovery contract"
            )
        if payload.get("providerSnapshotCapable") is not True:
            raise BacktestError(
                "RECOVERY_NOT_ALLOWED", "Provider does not declare snapshot/restore"
            )
        generation = int(record["generation"])
        stamp = now_ms or _now_ms()
        queued = transition(RunState.FAILED, RunState.QUEUED)
        changed = self.repository.compare_and_set_run_state(
            run_id,
            expected_state=RunState.FAILED.value,
            expected_generation=generation,
            state=queued.value,
            updated_at_ms=stamp,
            generation=generation + 1,
        )
        if not changed:
            raise BacktestError(
                "IDENTITY_MUTATION", "run changed while recovery was requested"
            )
        self._audit(
            run_id,
            "resume_from_checkpoint",
            {
                "schema": "BACKTEST_RECOVERY_V1",
                "checkpointSequence": int(checkpoint["sequence"]),
                "checkpointHash": str(checkpoint["state_hash"]),
                "fromGeneration": generation,
                "toGeneration": generation + 1,
            },
        )
        return self.get_run(run_id)

    def create_study(
        self, payload: Mapping[str, object], *, now_ms: int | None = None
    ) -> dict[str, object]:
        if not self.settings.enabled or not self.settings.study_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_STUDY_ENABLED is 0")
        requested_protocol = str(payload.get("study_protocol_revision") or "")
        if requested_protocol not in {"", "LEGACY_STUDY_V1", STUDY_PROTOCOL_V2}:
            raise BacktestError("FIDELITY_UNSUPPORTED", "unknown Study protocol")
        is_v2 = requested_protocol == STUDY_PROTOCOL_V2
        if is_v2:
            payload = self._normalize_study_v2(payload)
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
            revision_id = str(payload.get("strategy_revision_id") or "")
            persisted_study_revision = self.repository.get_strategy_revision(
                revision_id
            )
            if persisted_study_revision is None:
                try:
                    self.strategy_registry.require(revision_id)
                except StrategyProviderError as exc:
                    raise BacktestError(exc.code, str(exc)) from exc
            elif persisted_study_revision.get("archived_at_ms") is not None:
                raise BacktestError(
                    "IDENTITY_MUTATION",
                    "archived strategy revision cannot create a new Study",
                )
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
        config = json.loads(str(record["config_json"]))
        if config.get("study_protocol_revision") == STUDY_PROTOCOL_V2:
            return self.ensure_study_v2_plan(study_id)
        return self.ensure_study_trials(study_id)

    def _normalize_study_v2(self, payload: Mapping[str, object]) -> dict[str, object]:
        normalized = dict(payload)
        hypothesis = str(payload.get("hypothesis") or "").strip()
        if not hypothesis:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "Study V2 requires a hypothesis"
            )
        required_text = (
            "strategy_revision_id",
            "dataset_id",
            "data_epoch",
            "dataset_snapshot_hash",
            "interval",
        )
        missing = [
            name for name in required_text if not str(payload.get(name) or "").strip()
        ]
        if missing:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"Study V2 missing {missing}")
        try:
            start_ms = int(payload["start_ms"])
            end_ms = int(payload["end_ms"])
            train_ms = int(payload["train_ms"])
            test_ms = int(payload["test_ms"])
            step_ms = int(payload.get("step_ms") or test_ms)
            purge_ms = int(payload.get("purge_ms") or 0)
            embargo_ms = int(payload.get("embargo_ms") or 0)
            holdout_ms = int(payload.get("holdout_ms") or 0)
            seed = int(payload.get("seed") or 1)
            candidate_budget = int(
                payload.get("candidate_budget") or payload.get("max_trials") or 1
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "invalid Study V2 identity"
            ) from exc
        interval = parse_interval_spec(str(payload["interval"]))
        if interval is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "invalid Study V2 interval")
        if interval.floor_ms(start_ms) != start_ms:
            raise BacktestError(
                "STUDY_SPLIT_LEAK", "Study V2 start must be a bar-open boundary"
            )
        if interval.floor_ms(end_ms) == end_ms:
            end_exclusive_ms = end_ms
        elif interval.next_ms(interval.floor_ms(end_ms)) == end_ms + 1:
            end_exclusive_ms = end_ms + 1
        else:
            raise BacktestError(
                "STUDY_SPLIT_LEAK",
                "Study V2 end must be an exclusive boundary or inclusive bar close",
            )
        folds = walk_forward_folds_v2(
            start_ms=start_ms,
            end_ms=end_exclusive_ms,
            train_ms=train_ms,
            test_ms=test_ms,
            step_ms=step_ms,
            purge_ms=purge_ms,
            embargo_ms=embargo_ms,
            holdout_ms=holdout_ms,
        )
        space = payload.get("parameter_space") or {}
        if not isinstance(space, Mapping):
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "parameter_space must be an object"
            )
        sampler = str(payload.get("sampler") or "grid")
        candidates = sample_candidates_v2(
            space, sampler=sampler, seed=seed, candidate_budget=candidate_budget
        )
        if self.enforce_registered_revisions:
            try:
                descriptor = self.strategy_registry.require(
                    str(payload["strategy_revision_id"])
                )
            except StrategyProviderError as exc:
                raise BacktestError(exc.code, str(exc)) from exc
            for candidate in candidates:
                probe = descriptor.factory()
                try:
                    probe.prepare(
                        {
                            "roles": ["BARS"],
                            "parameters": {
                                **dict(payload.get("parameters") or {}),
                                **candidate,
                            },
                            "outputMode": "SIGNAL",
                        }
                    )
                except StrategyProviderError as exc:
                    raise BacktestError(exc.code, str(exc)) from exc
                finally:
                    probe.close()
        total_run_budget = len(folds) * (len(candidates) + 1) + int(holdout_ms > 0)
        requested_total = int(payload.get("total_run_budget") or total_run_budget)
        if requested_total != total_run_budget:
            raise BacktestError(
                "IDENTITY_MUTATION",
                "total_run_budget must equal the frozen fold/candidate plan",
            )
        if total_run_budget > self.settings.max_trials_per_study:
            raise BacktestError(
                "BUDGET_EXCEEDED", "Study V2 total runs exceed the frozen ceiling"
            )
        objective = str(payload.get("objective") or "SHARPE")
        if objective not in OBJECTIVES:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", f"unsupported objective {objective}"
            )
        constraints = {
            "min_closed_trades": 1,
            "max_drawdown": "1",
            "min_data_coverage": "1",
            "max_ambiguity_ratio": "0",
            "max_rejected_ratio": "0",
            "cost_plus_25_must_be_positive": True,
            "warn_min_long_trades": 1,
            "warn_min_short_trades": 1,
            **dict(payload.get("constraints") or {}),
        }
        try:
            if int(constraints["min_closed_trades"]) < 1:
                raise ValueError("min_closed_trades")
            for name in (
                "max_drawdown",
                "min_data_coverage",
                "max_ambiguity_ratio",
                "max_rejected_ratio",
            ):
                value = Decimal(str(constraints[name]))
                if not value.is_finite() or value < 0 or value > 1:
                    raise ValueError(name)
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "invalid Study V2 constraints"
            ) from exc
        if normalized.get("dataset_basket") in (None, {}, []):
            normalized.pop("dataset_basket", None)
        if self.settings.multi_market_enabled and normalized.get("dataset_basket"):
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                "independent dataset basket is not shared-capital multi-market",
            )
        if normalized.get("dataset_basket") is not None:
            basket = normalize_basket(normalized["dataset_basket"])
            train_ids = {
                str(member["dataset_id"])
                for member in basket["members"]
                if member["role"] == "TRAIN"
            }
            if str(payload["dataset_id"]) not in train_ids:
                raise BacktestError(
                    "STUDY_SPLIT_LEAK",
                    "Study V2 dataset_id must be a TRAIN basket member",
                )
            normalized["dataset_basket"] = basket
            normalized["dataset_basket_hash"] = basket["basket_hash"]
            normalized["basket_protocol_revision"] = BASKET_PROTOCOL_V1
        frozen = {
            **normalized,
            "study_schema": STUDY_SCHEMA_V2,
            "study_protocol_revision": STUDY_PROTOCOL_V2,
            "selection_protocol_revision": SELECTION_PROTOCOL_V2,
            "hypothesis": hypothesis,
            "start_ms": start_ms,
            "end_ms": end_exclusive_ms,
            "window_semantics": "START_INCLUSIVE_END_EXCLUSIVE_V2",
            "train_ms": train_ms,
            "test_ms": test_ms,
            "step_ms": step_ms,
            "purge_ms": purge_ms,
            "embargo_ms": embargo_ms,
            "holdout_ms": holdout_ms,
            "sampler": sampler,
            "seed": seed,
            "candidate_budget": len(candidates),
            "total_run_budget": total_run_budget,
            "objective": objective,
            "constraints": constraints,
            "tie_break": TIE_BREAK_V1,
            "account_model": "LINEAR_PERP_ONE_WAY_V2",
            "contract_data_mode": "HISTORICAL_CONTRACT_V1",
            "funding_mode": str(payload.get("funding_mode") or "OFF"),
            "execution_model_revision": EXECUTION_REALISM_V2,
            "fill_policy": BAR_FILL_POLICY_V2,
            "participation_rate": str(payload.get("participation_rate") or "0.1"),
            "latency_ms": 0,
            "latency_events": 0,
            "order_end_policy": "CANCEL_AT_END",
            "bar_path_scenario": "OHLC_WORST_CASE_STOP_FIRST_V1",
            "metrics_version": METRICS_VERSION,
            "report_schema": "candlescope.backtest-report/2",
            "equity_sampling": EQUITY_SAMPLING,
            "annualization_days": 365,
            "risk_free_rate_annual": str(payload.get("risk_free_rate_annual") or "0"),
            "benchmark_model": BENCHMARK_MODEL,
            "output_mode": "SIGNAL",
            "gap_policy": "REJECT",
        }
        for name, expected in (
            ("account_model", "LINEAR_PERP_ONE_WAY_V2"),
            ("contract_data_mode", "HISTORICAL_CONTRACT_V1"),
            ("selection_protocol_revision", SELECTION_PROTOCOL_V2),
            ("execution_model_revision", EXECUTION_REALISM_V2),
            ("metrics_version", METRICS_VERSION),
            ("tie_break", TIE_BREAK_V1),
        ):
            requested = payload.get(name)
            if requested is not None and str(requested) != expected:
                raise BacktestError(
                    "IDENTITY_MUTATION", f"Study V2 requires {name}={expected}"
                )
        return frozen

    def ensure_study_v2_plan(self, study_id: str) -> dict[str, object]:
        record = self.get_study(study_id)
        if record["state"] != "RUNNING":
            return record
        config = json.loads(str(record["config_json"]))
        folds = walk_forward_folds_v2(
            start_ms=int(config["start_ms"]),
            end_ms=int(config["end_ms"]),
            train_ms=int(config["train_ms"]),
            test_ms=int(config["test_ms"]),
            step_ms=int(config["step_ms"]),
            purge_ms=int(config["purge_ms"]),
            embargo_ms=int(config["embargo_ms"]),
            holdout_ms=int(config["holdout_ms"]),
        )
        candidates = sample_candidates_v2(
            config["parameter_space"],
            sampler=str(config["sampler"]),
            seed=int(config["seed"]),
            candidate_budget=int(config["candidate_budget"]),
        )
        trial_ordinal = 1
        for fold in folds:
            fold_id = f"{study_id}:fold:{fold.ordinal}"
            self.repository.insert_study_fold(
                {
                    "fold_id": fold_id,
                    "study_id": study_id,
                    "ordinal": fold.ordinal,
                    "train_start_ms": fold.train_start_ms,
                    "train_end_ms": fold.train_end_ms,
                    "test_start_ms": fold.test_start_ms,
                    "test_end_ms": fold.test_end_ms,
                    "purge_ms": fold.purge_ms,
                    "embargo_ms": fold.embargo_ms,
                    "state": "PLANNED",
                }
            )
            for candidate_ordinal, params in enumerate(candidates, 1):
                params_hash = "sha256:" + sha256_hex(params)
                self.repository.insert_train_trial(
                    {
                        "train_trial_id": f"{fold_id}:candidate:{candidate_ordinal}",
                        "study_id": study_id,
                        "fold_id": fold_id,
                        "ordinal": trial_ordinal,
                        "candidate_ordinal": candidate_ordinal,
                        "params_json": canonical_json(params),
                        "params_hash": params_hash,
                        "state": "PLANNED",
                    }
                )
                trial_ordinal += 1
        if int(config["holdout_ms"]) > 0:
            self.repository.insert_holdout(
                {
                    "study_id": study_id,
                    "start_ms": int(config["end_ms"]) - int(config["holdout_ms"]),
                    "end_ms": int(config["end_ms"]),
                }
            )
        return self.get_study(study_id)

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
        current = self.get_study(study_id)
        current_config = json.loads(str(current["config_json"]))
        if current_config.get("study_protocol_revision") == STUDY_PROTOCOL_V2:
            return self.materialize_study_v2_runs(
                study_id,
                preview_snapshot=preview_snapshot,
            )
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
                interval=(
                    None if config.get("interval") is None else str(config["interval"])
                ),
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
                enforce_active_budget=False,
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

    def materialize_study_v2_runs(
        self,
        study_id: str,
        *,
        preview_snapshot: Callable[..., Mapping[str, object]],
    ) -> dict[str, object]:
        self.ensure_study_v2_plan(study_id)
        record = self.get_study(study_id)
        if record["state"] != "RUNNING":
            return record
        config = json.loads(str(record["config_json"]))
        identity = study_v2_identity(config)
        for fold in self.repository.list_study_folds(study_id):
            if self.get_study(study_id)["state"] != "RUNNING":
                break
            fold_id = str(fold["fold_id"])
            trials = self.repository.list_train_trials(study_id, fold_id=fold_id)
            for trial in trials:
                run_id = trial.get("run_id")
                if run_id:
                    run = self.repository.get_run_by_id(str(run_id))
                    if run is not None and trial["state"] != run["state"]:
                        self.repository.update_train_trial_for_run(
                            str(run_id), state=str(run["state"])
                        )
                    continue
                if trial["state"] != "PLANNED":
                    continue
                params = {
                    **dict(config.get("parameters") or {}),
                    **json.loads(str(trial["params_json"])),
                }
                run = self._create_study_v2_child_run(
                    record,
                    config,
                    params=params,
                    role="TRAIN",
                    start_ms=int(fold["train_start_ms"]),
                    end_ms=int(fold["train_end_ms"]),
                    idempotency_key=f"{study_id}:{fold_id}:train:{trial['params_hash']}",
                    preview_snapshot=preview_snapshot,
                )
                attached = self.repository.attach_train_run(
                    str(trial["train_trial_id"]), run_id=str(run["run_id"])
                )
                if not attached:
                    latest = next(
                        item
                        for item in self.repository.list_train_trials(
                            study_id, fold_id=fold_id
                        )
                        if item["train_trial_id"] == trial["train_trial_id"]
                    )
                    if latest.get("run_id") != run["run_id"]:
                        self._cancel_if_active(str(run["run_id"]))
            trials = self.repository.list_train_trials(study_id, fold_id=fold_id)
            states = set()
            for trial in trials:
                run_id = trial.get("run_id")
                run = None if not run_id else self.repository.get_run_by_id(str(run_id))
                state = str(run["state"] if run is not None else trial["state"])
                states.add(state)
                if run_id and trial["state"] != state:
                    self.repository.update_train_trial_for_run(str(run_id), state=state)
            if states - {"COMPLETED", "FAILED", "CANCELLED"}:
                self.repository.update_study_fold_state(fold_id, "TRAINING")
                continue

            receipt_row = self.repository.get_selection_receipt(fold_id)
            if receipt_row is None:
                candidate_rows: list[dict[str, Any]] = []
                for trial in self.repository.list_train_trials(
                    study_id, fold_id=fold_id
                ):
                    run_id = trial.get("run_id")
                    run = (
                        None
                        if not run_id
                        else self.repository.get_run_by_id(str(run_id))
                    )
                    if run is None or run["state"] != "COMPLETED":
                        evaluation = {
                            "eligible": False,
                            "objective_value": None,
                            "max_drawdown": None,
                            "closed_trade_count": 0,
                            "data_coverage": "0",
                            "ambiguity_ratio": "0",
                            "rejected_ratio": "0",
                            "violations": ["TRAIN_RUN_NOT_COMPLETED"],
                            "warnings": [],
                        }
                    else:
                        stored_report = self.repository.get_report(str(run_id))
                        if stored_report is None:
                            evaluation = {
                                "eligible": False,
                                "objective_value": None,
                                "max_drawdown": None,
                                "closed_trade_count": 0,
                                "data_coverage": "0",
                                "ambiguity_ratio": "0",
                                "rejected_ratio": "0",
                                "violations": ["TRAIN_REPORT_MISSING"],
                                "warnings": [],
                            }
                        else:
                            evaluation = evaluate_train_candidate(
                                json.loads(str(stored_report["report_json"])),
                                objective=str(config["objective"]),
                                constraints=config["constraints"],
                            )
                    self.repository.save_train_evaluation(
                        str(trial["train_trial_id"]),
                        objective_value=evaluation.get("objective_value"),
                        eligible=bool(evaluation["eligible"]),
                        violations_json=canonical_json(evaluation["violations"]),
                        warnings_json=canonical_json(evaluation["warnings"]),
                    )
                    candidate_rows.append(
                        {
                            "candidate_ordinal": trial["candidate_ordinal"],
                            "params": json.loads(str(trial["params_json"])),
                            "params_hash": trial["params_hash"],
                            "evaluation": evaluation,
                            "train_trial_id": trial["train_trial_id"],
                        }
                    )
                fold_spec = FoldSpecV2(
                    ordinal=int(fold["ordinal"]),
                    train_start_ms=int(fold["train_start_ms"]),
                    train_end_ms=int(fold["train_end_ms"]),
                    test_start_ms=int(fold["test_start_ms"]),
                    test_end_ms=int(fold["test_end_ms"]),
                    purge_ms=int(fold["purge_ms"]),
                    embargo_ms=int(fold["embargo_ms"]),
                )
                try:
                    receipt = build_selection_receipt(
                        identity=identity,
                        fold=fold_spec,
                        candidates=candidate_rows,
                        objective=str(config["objective"]),
                        constraints=config["constraints"],
                    )
                except BacktestError as exc:
                    if exc.code == "STUDY_NO_ELIGIBLE_CANDIDATE":
                        self.repository.update_study_fold_state(fold_id, "FAILED")
                        self.repository.update_study_state(study_id, "FAILED")
                    raise
                selected_ordinal = int(receipt["selected"]["candidate_ordinal"])
                selected_trial = next(
                    item
                    for item in candidate_rows
                    if int(item["candidate_ordinal"]) == selected_ordinal
                )
                receipt_row = self.repository.insert_selection_receipt(
                    {
                        "receipt_hash": receipt["hashes"]["receipt"],
                        "study_id": study_id,
                        "fold_id": fold_id,
                        "payload_json": canonical_json(receipt),
                        "selected_train_trial_id": selected_trial["train_trial_id"],
                        "selected_params_json": canonical_json(
                            receipt["selected"]["params"]
                        ),
                        "selected_params_hash": receipt["selected"]["params_hash"],
                        "created_at_ms": _now_ms(),
                    }
                )
                if receipt_row["receipt_hash"] != receipt["hashes"]["receipt"]:
                    raise BacktestError(
                        "HASH_MISMATCH",
                        "fold already has a different selection receipt",
                    )
            receipt = json.loads(str(receipt_row["payload_json"]))
            if not verify_selection_receipt(receipt):
                raise BacktestError("HASH_MISMATCH", "selection receipt is corrupt")

            fold = next(
                item
                for item in self.repository.list_study_folds(study_id)
                if item["fold_id"] == fold_id
            )
            test_run_id = fold.get("test_run_id")
            if not test_run_id:
                params = {
                    **dict(config.get("parameters") or {}),
                    **dict(receipt["selected"]["params"]),
                }
                test_run = self._create_study_v2_child_run(
                    record,
                    config,
                    params=params,
                    role="TEST",
                    start_ms=int(fold["test_start_ms"]),
                    end_ms=int(fold["test_end_ms"]),
                    idempotency_key=(
                        f"{study_id}:{fold_id}:test:{receipt['hashes']['receipt']}"
                    ),
                    preview_snapshot=preview_snapshot,
                )
                attached = self.repository.attach_fold_test_run(
                    fold_id, run_id=str(test_run["run_id"])
                )
                if not attached:
                    refreshed = next(
                        item
                        for item in self.repository.list_study_folds(study_id)
                        if item["fold_id"] == fold_id
                    )
                    if refreshed.get("test_run_id") != test_run["run_id"]:
                        self._cancel_if_active(str(test_run["run_id"]))
                test_run_id = test_run["run_id"]
            test_run = self.repository.get_run_by_id(str(test_run_id))
            if test_run is None:
                raise BacktestError("IDENTITY_MUTATION", "fold test run is missing")
            if test_run["state"] == "COMPLETED":
                self.repository.update_study_fold_state(fold_id, "COMPLETED")
            elif test_run["state"] in {"FAILED", "CANCELLED"}:
                self.repository.update_study_fold_state(fold_id, "FAILED")
                self.repository.update_study_state(study_id, "FAILED")
                return self.get_study(study_id)
            else:
                self.repository.update_study_fold_state(fold_id, "TEST_RUNNING")

        folds = self.repository.list_study_folds(study_id)
        if folds and all(fold["state"] == "COMPLETED" for fold in folds):
            self._seal_study_v2_oos(study_id, config=config, identity=identity)
            holdout = self.repository.get_holdout(study_id)
            if holdout is None:
                self.repository.update_study_state(study_id, "COMPLETED")
            elif holdout["state"] == "SEALED":
                self.repository.update_study_state(study_id, "AWAITING_HOLDOUT")
            elif holdout["state"] in {"REVEALED", "QUEUED", "RUNNING"}:
                self._materialize_holdout_run(
                    record,
                    config,
                    holdout,
                    preview_snapshot=preview_snapshot,
                )
                holdout = self.repository.get_holdout(study_id)
                run = (
                    None
                    if holdout is None or not holdout.get("run_id")
                    else self.repository.get_run_by_id(str(holdout["run_id"]))
                )
                if run is not None and run["state"] == "COMPLETED":
                    self.repository.update_holdout_state(study_id, "COMPLETED")
                    self.repository.update_study_state(study_id, "COMPLETED")
                elif run is not None and run["state"] in {"FAILED", "CANCELLED"}:
                    self.repository.update_holdout_state(study_id, str(run["state"]))
                    self.repository.update_study_state(study_id, "FAILED")
                elif run is not None:
                    self.repository.update_holdout_state(study_id, "RUNNING")
        return self.get_study(study_id)

    def _create_study_v2_child_run(
        self,
        study: Mapping[str, object],
        config: Mapping[str, Any],
        *,
        params: Mapping[str, Any],
        role: str,
        start_ms: int,
        end_ms: int,
        idempotency_key: str,
        preview_snapshot: Callable[..., Mapping[str, object]],
    ) -> dict[str, object]:
        if end_ms <= start_ms:
            raise BacktestError("STUDY_SPLIT_LEAK", f"empty {role} window")
        preview = preview_snapshot(
            dataset_id=str(config["dataset_id"]),
            data_epoch=str(config["data_epoch"]),
            start_time_ms=start_ms,
            end_time_ms=end_ms - 1,
            interval=str(config["interval"]),
            contract_data_mode="HISTORICAL_CONTRACT_V1",
            account_model="LINEAR_PERP_ONE_WAY_V2",
            funding_mode=str(config.get("funding_mode") or "OFF"),
        )
        warmup = max(
            int(config.get("warmup_bars") or 0),
            int(params.get("length") or 0) + 1,
        )
        payload = {
            "strategy_revision_id": study["strategy_revision_id"],
            "dataset_id": config["dataset_id"],
            "data_epoch": config["data_epoch"],
            "snapshot_hash": preview["snapshot_hash"],
            "fidelity_mode": "BAR_APPROX",
            "start_time_ms": start_ms,
            "end_time_ms": end_ms - 1,
            "warmup_bars": warmup,
            "interval": config["interval"],
            "parameters": dict(params),
            "output_mode": "SIGNAL",
            "initial_balance": config.get("initial_balance", "10000"),
            "slippage_bps": config.get("slippage_bps", "1"),
            "taker_fee_bps": config.get("taker_fee_bps", "0"),
            "maker_fee_bps": config.get("maker_fee_bps", "0"),
            "gap_policy": "REJECT",
            "study_id": study["study_id"],
            "account_model": "LINEAR_PERP_ONE_WAY_V2",
            "contract_data_mode": "HISTORICAL_CONTRACT_V1",
            "funding_mode": config.get("funding_mode", "OFF"),
            "leverage": config.get("leverage", "1"),
            "execution_model_revision": EXECUTION_REALISM_V2,
            "participation_rate": config.get("participation_rate", "0.1"),
            "latency_ms": 0,
            "latency_events": 0,
            "order_end_policy": "CANCEL_AT_END",
            "bar_path_scenario": "OHLC_WORST_CASE_STOP_FIRST_V1",
            "metrics_version": METRICS_VERSION,
            "risk_free_rate_annual": config.get("risk_free_rate_annual", "0"),
            "sample_role": "IN_SAMPLE" if role == "TRAIN" else "OUT_OF_SAMPLE",
            "sizing_policy": config.get("sizing_policy", "FIXED_QTY_V1"),
            "fixed_qty": config.get("fixed_qty", "1"),
            "max_abs_position": config.get("max_abs_position", "100"),
            "max_notional": config.get("max_notional", "1000000"),
            "max_leverage": config.get("max_leverage", "20"),
            "max_risk_per_trade": config.get("max_risk_per_trade", "10000"),
            "max_active_orders": config.get("max_active_orders", 20),
            "max_cumulative_fees": config.get("max_cumulative_fees", "10000"),
            "max_drawdown_stop_pct": config.get("max_drawdown_stop_pct", "50"),
        }
        return self.create_run(
            payload,
            idempotency_key=idempotency_key,
            enforce_active_budget=False,
        )

    def _seal_study_v2_oos(
        self,
        study_id: str,
        *,
        config: Mapping[str, Any],
        identity: Mapping[str, Any],
    ) -> None:
        existing = self.repository.get_oos_report(study_id)
        fold_inputs: list[dict[str, Any]] = []
        for fold in self.repository.list_study_folds(study_id):
            test_run_id = str(fold.get("test_run_id") or "")
            stored = self.repository.get_report(test_run_id)
            receipt_row = self.repository.get_selection_receipt(str(fold["fold_id"]))
            if stored is None or receipt_row is None:
                raise BacktestError(
                    "IDENTITY_MUTATION", "completed fold evidence is missing"
                )
            fold_inputs.append(
                {
                    "ordinal": fold["ordinal"],
                    "run_role": "TEST",
                    "test_run_id": test_run_id,
                    "report": json.loads(str(stored["report_json"])),
                    "receipt": json.loads(str(receipt_row["payload_json"])),
                }
            )
        report = build_oos_report(
            identity=identity,
            folds=fold_inputs,
            seed=int(config["seed"]),
        )
        if not verify_oos_report(report):
            raise BacktestError("HASH_MISMATCH", "OOS report hash failed self-check")
        if existing is not None:
            if existing["report_hash"] != report["hashes"]["report"]:
                raise BacktestError("HASH_MISMATCH", "stored OOS report changed")
            return
        self.repository.save_oos_report(
            study_id,
            report_schema=OOS_REPORT_SCHEMA,
            report_json=canonical_json(report),
            report_hash=report["hashes"]["report"],
            generated_at_ms=_now_ms(),
        )

    def reveal_study_holdout(self, study_id: str) -> dict[str, object]:
        study = self.get_study(study_id)
        config = json.loads(str(study["config_json"]))
        if config.get("study_protocol_revision") != STUDY_PROTOCOL_V2:
            raise BacktestError(
                "FIDELITY_UNSUPPORTED", "legacy Study has no sealed holdout"
            )
        if study["state"] not in {"AWAITING_HOLDOUT", "RUNNING", "COMPLETED"}:
            raise BacktestError("IDENTITY_MUTATION", "holdout cannot be revealed yet")
        holdout = self.repository.get_holdout(study_id)
        if holdout is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "Study has no holdout")
        if holdout.get("reveal_receipt_hash"):
            return self.get_study(study_id)
        receipts = [
            self.repository.get_selection_receipt(str(fold["fold_id"]))
            for fold in self.repository.list_study_folds(study_id)
        ]
        if not receipts or any(item is None for item in receipts):
            raise BacktestError(
                "IDENTITY_MUTATION", "all fold selections must be sealed"
            )
        counts: dict[str, tuple[int, dict[str, Any]]] = {}
        for row in receipts:
            assert row is not None
            params = json.loads(str(row["selected_params_json"]))
            params_hash = str(row["selected_params_hash"])
            count, _ = counts.get(params_hash, (0, params))
            counts[params_hash] = (count + 1, params)
        selected_hash, (_, params) = min(
            counts.items(), key=lambda item: (-item[1][0], item[0])
        )
        receipt = build_holdout_receipt(
            identity=study_v2_identity(config),
            params=params,
            start_ms=int(holdout["start_ms"]),
            end_ms=int(holdout["end_ms"]),
        )
        if receipt["params_hash"] != selected_hash:
            raise BacktestError("HASH_MISMATCH", "holdout parameter mode changed")
        self.repository.reveal_holdout(
            study_id,
            receipt_hash=receipt["hashes"]["receipt"],
            receipt_json=canonical_json(receipt),
            params_json=canonical_json(params),
            revealed_at_ms=_now_ms(),
        )
        self.repository.update_study_state(study_id, "RUNNING")
        return self.get_study(study_id)

    def _materialize_holdout_run(
        self,
        study: Mapping[str, object],
        config: Mapping[str, Any],
        holdout: Mapping[str, Any],
        *,
        preview_snapshot: Callable[..., Mapping[str, object]],
    ) -> None:
        if holdout.get("run_id"):
            return
        receipt = json.loads(str(holdout["receipt_json"]))
        if receipt.get(
            "schemaVersion"
        ) != HOLDOUT_RECEIPT_SCHEMA or not verify_holdout_receipt(receipt):
            raise BacktestError("HASH_MISMATCH", "holdout receipt schema mismatch")
        run = self._create_study_v2_child_run(
            study,
            config,
            params={
                **dict(config.get("parameters") or {}),
                **json.loads(str(holdout["params_json"])),
            },
            role="HOLDOUT",
            start_ms=int(holdout["start_ms"]),
            end_ms=int(holdout["end_ms"]),
            idempotency_key=(
                f"{study['study_id']}:holdout:{holdout['reveal_receipt_hash']}"
            ),
            preview_snapshot=preview_snapshot,
        )
        if not self.repository.attach_holdout_run(
            str(study["study_id"]), run_id=str(run["run_id"])
        ):
            latest = self.repository.get_holdout(str(study["study_id"]))
            if latest is None or latest.get("run_id") != run["run_id"]:
                self._cancel_if_active(str(run["run_id"]))

    def _cancel_if_active(self, run_id: str) -> None:
        run = self.repository.get_run_by_id(run_id)
        if run is not None and run["state"] not in {"COMPLETED", "FAILED", "CANCELLED"}:
            self.cancel_run(run_id)

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
        config = json.loads(str(record["config_json"]))
        if config.get("study_protocol_revision") == STUDY_PROTOCOL_V2:
            for trial in self.repository.list_train_trials(study_id):
                run_id = trial.get("run_id")
                if run_id:
                    self._cancel_if_active(str(run_id))
                    latest = self.repository.get_run_by_id(str(run_id))
                    if latest is not None:
                        self.repository.update_train_trial_for_run(
                            str(run_id), state=str(latest["state"])
                        )
            for fold in self.repository.list_study_folds(study_id):
                run_id = fold.get("test_run_id")
                if run_id:
                    self._cancel_if_active(str(run_id))
                if fold["state"] != "COMPLETED":
                    self.repository.update_study_fold_state(
                        str(fold["fold_id"]), "CANCELLED"
                    )
            holdout = self.repository.get_holdout(study_id)
            if holdout is not None and holdout.get("run_id"):
                self._cancel_if_active(str(holdout["run_id"]))
                latest = self.repository.get_run_by_id(str(holdout["run_id"]))
                if latest is not None and latest["state"] != "COMPLETED":
                    self.repository.update_holdout_state(study_id, "CANCELLED")
            return self.get_study(study_id)
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
        events: Iterable[MarketEvent],
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
            try:
                config = json.loads(str(record["config_json"]))
            except (TypeError, ValueError, json.JSONDecodeError):
                config = {}
            planner = PyneHostPlanner(
                config, execution_reporter=self._execution_reporter(session)
            )
            adapter.start(
                {
                    "roles": ["BARS"],
                    "source": config.get("strategy_source"),
                    "parameters": config.get("parameters") or {},
                    "seed": config.get("seed"),
                    "outputMode": config.get("output_mode") or "TARGET_POSITION",
                    "tradeExplanationEnabled": self.settings.trade_explanation_effective,
                }
            )

            materialized = isinstance(events, tuple)
            if materialized:
                bar_event_count = sum(event.role == "BARS" for event in events)
                if bar_event_count > self.settings.max_bar_rows:
                    raise BacktestError(
                        "BUDGET_EXCEEDED",
                        "BAR event count exceeds frozen row ceiling",
                    )
                event_bytes = _event_wire_bytes(events)
                if event_bytes > self.settings.worker_memory_mb * 1024 * 1024:
                    raise BacktestError(
                        "BUDGET_EXCEEDED",
                        "BAR snapshot exceeds worker memory ceiling",
                    )
            else:
                event_bytes = 0

            observed = 0
            resume_sequence = 0

            kernel = SimulationKernel(
                account_model=str(
                    config.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"
                ),
                funding_mode=str(config.get("funding_mode") or "OFF"),
                leverage=_config_decimal(config, "leverage", "1"),
                host_policy_revision=config.get("host_policy_revision"),
                slippage_bps=_config_decimal(config, "slippage_bps", "1"),
                taker_fee_bps=_config_decimal(config, "taker_fee_bps", "0"),
                maker_fee_bps=_config_decimal(config, "maker_fee_bps", "0"),
                funding_rate=_config_decimal(config, "funding_rate", "0"),
                funding_interval_ms=int(config.get("funding_interval_hours") or 8)
                * 3_600_000,
                initial_balance=_config_decimal(config, "initial_balance", "10000"),
                price_tick=_config_optional_decimal(config, "price_tick"),
                qty_step=_config_optional_decimal(config, "qty_step"),
                min_notional=_config_optional_decimal(config, "min_notional"),
                gap_policy=str(config.get("gap_policy") or "REJECT"),
                **_execution_kernel_kwargs(config),
                execution_reporter=self._execution_reporter(session),
            )
            from app.backtest.strategy.python_scale import scale_v1_enabled

            if scale_v1_enabled():
                if kernel.equity_curve_event_interval < 10_000:
                    kernel.equity_curve_event_interval = 10_000
                kernel.scale_stream_decisions = True
            checkpoint = self.repository.latest_checkpoint(run_id)
            if checkpoint is not None:
                payload = self._verified_checkpoint_payload(record, checkpoint)
                if (
                    payload.get("schemaVersion") == "candlescope.backtest-checkpoint/2"
                    and payload.get("checkpointMode") != "BAR"
                ):
                    raise BacktestError(
                        "CHECKPOINT_CORRUPT", "checkpoint mode does not match BAR run"
                    )
                kernel.restore(payload["engine"])
                session.restore(payload["provider"])
                session.generation = int(record["generation"])
                planner.restore(payload.get("planner") or {})
                observed = int(payload["observed"])
                resume_sequence = int(payload["sequence"])

            if checkpoint is None:
                self._save_bar_checkpoint(
                    record,
                    sequence=0,
                    observed=0,
                    kernel=kernel,
                    session=session,
                    planner=planner,
                    event_bytes=event_bytes,
                )

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
                self._maybe_inject_fault(
                    "before_decision", run_id=run_id, sequence=event.sequence
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
                return planner.plan(
                    wire,
                    context=_planning_context(kernel, event),
                )

            streamed_last: MarketEvent | None = None
            streamed_count = 0

            def remaining_events() -> Iterable[MarketEvent]:
                nonlocal streamed_last, streamed_count
                seen_bars = 0
                for event in events:
                    if event.sequence <= resume_sequence:
                        continue
                    if event.role == "BARS":
                        seen_bars += 1
                        streamed_count = resume_sequence + seen_bars
                        if streamed_count > self.settings.max_bar_rows:
                            raise BacktestError(
                                "BUDGET_EXCEEDED",
                                "BAR event count exceeds frozen row ceiling",
                            )
                    streamed_last = event
                    yield event

            last_order_count = len(kernel.orders)
            last_fill_count = len(kernel.fills)

            def checkpoint_after(event: MarketEvent) -> None:
                nonlocal last_order_count, last_fill_count
                interval = self.settings.checkpoint_event_interval
                order_count = len(kernel.orders)
                fill_count = len(kernel.fills)
                fault_point = None
                if event.role == "FUNDING":
                    fault_point = "after_funding"
                elif fill_count > last_fill_count and any(
                    order.status == "PARTIAL" for order in kernel.orders
                ):
                    fault_point = "after_partial_fill"
                elif order_count > last_order_count:
                    fault_point = "after_order"
                if (interval > 0 and observed > 0 and observed % interval == 0) or (
                    self._fault_injector is not None and fault_point
                ):
                    self._save_bar_checkpoint(
                        record,
                        sequence=event.sequence,
                        observed=observed,
                        kernel=kernel,
                        session=session,
                        planner=planner,
                        event_bytes=event_bytes,
                    )
                last_order_count = order_count
                last_fill_count = fill_count
                if fault_point is not None:
                    self._maybe_inject_fault(
                        fault_point, run_id=run_id, sequence=event.sequence
                    )

            result = kernel.run(
                remaining_events(),
                strategy,
                warmup_events=0,
                finalize=True,
                checkpoint_callback=checkpoint_after,
            )
            cost_sensitivity = (
                build_cost_sensitivity_matrix(kernel, events, result)
                if materialized
                else None
            )
            metrics_market_context = _metrics_market_context(
                config, events if materialized else (), result.fills
            )
            self._assert_execution_control(
                run_id,
                deadline=deadline,
                expected_generation=expected_generation,
            )
            self._assert_provider_state_budget(session.snapshot())
            strategy_metadata = _provider_report_metadata(provider)
            final_sequence = (
                events[-1].sequence
                if materialized and events
                else (
                    streamed_last.sequence
                    if streamed_last is not None
                    else resume_sequence
                )
            )
            self._save_bar_checkpoint(
                record,
                sequence=final_sequence,
                observed=observed,
                kernel=kernel,
                session=session,
                planner=planner,
                event_bytes=event_bytes,
            )
            self._maybe_inject_fault(
                "before_report_seal", run_id=run_id, sequence=final_sequence
            )
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
                )
                | kernel.account.coverage(),
                "fill_model": {
                    "name": (
                        BAR_FILL_POLICY_V2
                        if kernel.execution_model_revision == EXECUTION_REALISM_V2
                        else "BAR_NEXT_BAR_WORST_CASE_V1"
                    ),
                    "slippage_bps": str(kernel.slippage_bps),
                    "taker_fee_bps": str(kernel.taker_fee_bps),
                    "maker_fee_bps": str(kernel.maker_fee_bps),
                    "funding_rate": str(kernel.funding_rate),
                    "funding_interval_hours": kernel.funding_interval_ms // 3_600_000,
                    "funding_model": (
                        str(config.get("funding_mode") or "OFF")
                        if str(config.get("account_model")) == "LINEAR_PERP_ONE_WAY_V2"
                        else (
                            "OFF" if kernel.funding_rate == 0 else "FIXED_INTERVAL_V1"
                        )
                    ),
                    "gap_policy": kernel.gap_policy,
                    "order_closeout": "CANCEL_OPEN_AT_END",
                    **_execution_fill_model(config),
                },
                "cost_sensitivity": cost_sensitivity,
                "metrics_market_context": metrics_market_context,
            }
            | _policy_result_overrides(planner, result),
        )

    def execute_dual_clock_run(
        self,
        run_id: str,
        *,
        events: tuple[MarketEvent, ...],
        provider: object,
        now_ms: int | None = None,
        warmup_events: int | None = None,
        snapshot_evidence: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        """Run completed-bar strategy signals against subsequent aggTrade prints."""
        if not self.settings.trade_tape_effective:
            raise BacktestError("FLAG_DISABLED", "TRADE_TAPE backtests are disabled")
        record = self.get_run(run_id)
        current = RunState(record["state"])
        if record["fidelity_mode"] != "AGG_TRADE_EXECUTION":
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                "execute_dual_clock_run only supports AGG_TRADE_EXECUTION",
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
            try:
                config = json.loads(str(record["config_json"]))
            except (TypeError, ValueError, json.JSONDecodeError):
                config = {}
            planner = PyneHostPlanner(
                config, execution_reporter=self._execution_reporter(session)
            )
            adapter.start(
                {
                    "roles": ["BARS"],
                    "source": config.get("strategy_source"),
                    "parameters": config.get("parameters") or {},
                    "seed": config.get("seed"),
                    "outputMode": config.get("output_mode") or "TARGET_POSITION",
                    "signalClock": SIGNAL_CLOCK,
                    "executionClock": EXECUTION_CLOCK,
                    "tradeExplanationEnabled": self.settings.trade_explanation_effective,
                }
            )
            event_bytes = _event_wire_bytes(events)
            if event_bytes > self.settings.worker_memory_mb * 1024 * 1024:
                raise BacktestError(
                    "BUDGET_EXCEEDED",
                    "aggregate-trade snapshot exceeds worker memory ceiling",
                )
            kernel = DualClockSimulationKernel(
                signal_interval=str(config["signal_interval"]),
                gap_policy="REJECT",
                max_events=self.settings.max_trade_events,
                checkpoint_event_interval=self.settings.checkpoint_event_interval,
                slippage_bps=_config_decimal(config, "slippage_bps", "1"),
                taker_fee_bps=_config_decimal(config, "taker_fee_bps", "0"),
                maker_fee_bps=_config_decimal(config, "maker_fee_bps", "0"),
                funding_rate=_config_decimal(config, "funding_rate", "0"),
                funding_interval_ms=int(config.get("funding_interval_hours") or 8)
                * 3_600_000,
                initial_balance=_config_decimal(config, "initial_balance", "10000"),
                account_model=str(
                    config.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"
                ),
                funding_mode=str(config.get("funding_mode") or "OFF"),
                leverage=_config_decimal(config, "leverage", "1"),
                host_policy_revision=config.get("host_policy_revision"),
                **_execution_kernel_kwargs(config),
                execution_reporter=self._execution_reporter(session),
            )
            resume_sequence = 0
            checkpoint = self.repository.latest_checkpoint(run_id)
            if checkpoint is not None:
                payload = self._verified_checkpoint_payload(record, checkpoint)
                if (
                    payload.get("schemaVersion") == "candlescope.backtest-checkpoint/2"
                    and payload.get("checkpointMode") != "DUAL_CLOCK"
                ):
                    raise BacktestError(
                        "CHECKPOINT_CORRUPT",
                        "checkpoint mode does not match dual-clock run",
                    )
                kernel.restore(payload["engine"])
                session.restore(payload["provider"])
                session.generation = int(record["generation"])
                planner.restore(payload.get("planner") or {})
                resume_sequence = int(payload["sequence"])

            if checkpoint is None:
                self._save_dual_clock_checkpoint(
                    record,
                    sequence=0,
                    kernel=kernel,
                    session=session,
                    planner=planner,
                    event_bytes=event_bytes,
                )

            def strategy(
                _visible: tuple[MarketEvent, ...], bar: MarketEvent
            ) -> list[dict]:
                if bar.sequence % 256 == 1:
                    self._assert_execution_control(
                        run_id,
                        deadline=deadline,
                        expected_generation=expected_generation,
                    )
                self._maybe_inject_fault(
                    "before_decision", run_id=run_id, sequence=bar.sequence
                )
                phase = "WARMUP" if bar.sequence <= warmup_events else "EVALUATION"
                bar_payload = dict(bar.payload)
                self._assert_frame_inputs(provider, bar=bar_payload, trade=None)
                wire = adapter.observe(
                    sequence=bar.sequence,
                    event_time_ms=bar.event_time_ms,
                    watermark_ms=bar.event_time_ms,
                    phase=phase,
                    market={"venue": "local", "symbol": str(record["dataset_id"])},
                    bar=bar_payload,
                    features=self._observation_features(
                        provider, bar=bar_payload, trade=None
                    ),
                )
                return planner.plan(
                    wire,
                    context=_planning_context(kernel.execution, bar),
                )

            remaining_events = tuple(
                event for event in events if event.sequence > resume_sequence
            )

            last_order_count = len(kernel.execution.orders)
            last_fill_count = len(kernel.execution.fills)

            def checkpoint_after(event: MarketEvent) -> None:
                nonlocal last_order_count, last_fill_count
                order_count = len(kernel.execution.orders)
                fill_count = len(kernel.execution.fills)
                fault_point = None
                if event.role == "FUNDING":
                    fault_point = "after_funding"
                elif fill_count > last_fill_count and any(
                    order.status == "PARTIAL" for order in kernel.execution.orders
                ):
                    fault_point = "after_partial_fill"
                elif order_count > last_order_count:
                    fault_point = "after_order"
                interval = self.settings.checkpoint_event_interval
                periodic = (
                    interval > 0
                    and kernel.execution_event_count > 0
                    and kernel.execution_event_count % interval == 0
                )
                if periodic or (self._fault_injector is not None and fault_point):
                    self._save_dual_clock_checkpoint(
                        record,
                        sequence=event.sequence,
                        kernel=kernel,
                        session=session,
                        planner=planner,
                        event_bytes=event_bytes,
                    )
                last_order_count = order_count
                last_fill_count = fill_count
                if fault_point is not None:
                    self._maybe_inject_fault(
                        fault_point, run_id=run_id, sequence=event.sequence
                    )

            result = kernel.run(
                remaining_events,
                strategy,
                warmup_events=0,
                finalize=True,
                checkpoint_callback=checkpoint_after,
            )
            cost_sensitivity = build_cost_sensitivity_matrix(kernel, events, result)
            metrics_market_context = _metrics_market_context(
                config, events, result.fills
            )
            self._assert_execution_control(
                run_id,
                deadline=deadline,
                expected_generation=expected_generation,
            )
            self._assert_provider_state_budget(session.snapshot())
            strategy_metadata = _provider_report_metadata(provider)
            final_sequence = events[-1].sequence if events else resume_sequence
            self._save_dual_clock_checkpoint(
                record,
                sequence=final_sequence,
                kernel=kernel,
                session=session,
                planner=planner,
                event_bytes=event_bytes,
            )
            self._maybe_inject_fault(
                "before_report_seal", run_id=run_id, sequence=final_sequence
            )
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
            chart_interval=str(config["signal_interval"]),
            chart_bars=[
                {
                    "time": int(bar.payload["open_time_ms"]) // 1000,
                    "open": float(bar.payload["open"]),
                    "high": float(bar.payload["high"]),
                    "low": float(bar.payload["low"]),
                    "close": float(bar.payload["close"]),
                    "volume": float(bar.payload["volume"]),
                }
                for bar in derive_complete_trade_bars(
                    events, str(config["signal_interval"])
                )
            ],
            result_overrides={
                "report_label": "AGGREGATED_TRADE_SEQUENCE",
                "strategy_metadata": strategy_metadata,
                "signal_event_count": kernel.builder.signal_count,
                "execution_event_count": kernel.execution_event_count,
                "data_quality": dict((snapshot_evidence or {}).get("quality") or {}),
                "contract_coverage": kernel.account.coverage(),
                "fill_model": {
                    "name": (
                        TRADE_FILL_POLICY_V2
                        if kernel.execution.execution_model_revision
                        == EXECUTION_REALISM_V2
                        else "TRADE_NEXT_PRINT_CONSERVATIVE_V1"
                    ),
                    "signal_clock": SIGNAL_CLOCK,
                    "execution_clock": EXECUTION_CLOCK,
                    "bar_builder": BAR_BUILDER_REVISION,
                    "signal_interval": kernel.signal_interval,
                    "timezone": BAR_TIMEZONE,
                    "source_honesty": "aggTrade is aggregated; raw trades and queue position are unmodeled",
                    **_execution_fill_model(config),
                    "slippage_bps": str(kernel.execution.slippage_bps),
                    "taker_fee_bps": str(kernel.execution.taker_fee_bps),
                    "maker_fee_bps": str(kernel.execution.maker_fee_bps),
                    "funding_rate": str(kernel.execution.funding_rate),
                    "funding_interval_hours": kernel.execution.funding_interval_ms
                    // 3_600_000,
                    "funding_model": (
                        str(config.get("funding_mode") or "OFF")
                        if str(config.get("account_model")) == "LINEAR_PERP_ONE_WAY_V2"
                        else (
                            "OFF"
                            if kernel.execution.funding_rate == 0
                            else "FIXED_INTERVAL_V1"
                        )
                    ),
                },
                "cost_sensitivity": cost_sensitivity,
                "metrics_market_context": metrics_market_context,
            }
            | _policy_result_overrides(planner, result),
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
            try:
                config = json.loads(str(record["config_json"]))
            except (TypeError, ValueError, json.JSONDecodeError):
                config = {}
            planner = PyneHostPlanner(
                config, execution_reporter=self._execution_reporter(session)
            )
            adapter.start(
                {
                    "roles": ["TRADES"],
                    "source": config.get("strategy_source"),
                    "parameters": config.get("parameters") or {},
                    "seed": config.get("seed"),
                    "outputMode": config.get("output_mode") or "TARGET_POSITION",
                    "tradeExplanationEnabled": self.settings.trade_explanation_effective,
                }
            )

            event_bytes = _event_wire_bytes(events)
            if event_bytes > self.settings.worker_memory_mb * 1024 * 1024:
                raise BacktestError(
                    "BUDGET_EXCEEDED",
                    "trade snapshot exceeds worker memory ceiling",
                )

            observed = 0
            resume_sequence = 0
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
                self._maybe_inject_fault(
                    "before_decision",
                    run_id=run_id,
                    sequence=event.sequence,
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
                return planner.plan(
                    wire,
                    context=_planning_context(kernel, event),
                )

            kernel = TradeSimulationKernel(
                account_model=str(
                    config.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"
                ),
                funding_mode=str(config.get("funding_mode") or "OFF"),
                leverage=_config_decimal(config, "leverage", "1"),
                host_policy_revision=config.get("host_policy_revision"),
                max_events=self.settings.max_trade_events,
                checkpoint_event_interval=self.settings.checkpoint_event_interval,
                slippage_bps=_config_decimal(config, "slippage_bps", "1"),
                taker_fee_bps=_config_decimal(config, "taker_fee_bps", "0"),
                maker_fee_bps=_config_decimal(config, "maker_fee_bps", "0"),
                funding_rate=_config_decimal(config, "funding_rate", "0"),
                funding_interval_ms=int(config.get("funding_interval_hours") or 8)
                * 3_600_000,
                initial_balance=_config_decimal(config, "initial_balance", "10000"),
                **_execution_kernel_kwargs(config),
                execution_reporter=self._execution_reporter(session),
            )
            checkpoint = self.repository.latest_checkpoint(run_id)
            if checkpoint is not None:
                payload = self._verified_checkpoint_payload(record, checkpoint)
                if (
                    payload.get("schemaVersion") == "candlescope.backtest-checkpoint/2"
                    and payload.get("checkpointMode") != "TRADE_TAPE"
                ):
                    raise BacktestError(
                        "CHECKPOINT_CORRUPT", "checkpoint mode does not match trade run"
                    )
                kernel.restore(payload["engine"])
                session.restore(payload["provider"])
                session.generation = int(record["generation"])
                planner.restore(payload.get("planner") or {})
                observed = int(payload["observed"])
                resume_sequence = int(payload["sequence"])
                aggregate = payload.get("aggregateState") or {}
                if aggregate:
                    try:
                        aggregate_open = Decimal(str(aggregate["open"]))
                        aggregate_high = Decimal(str(aggregate["high"]))
                        aggregate_low = Decimal(str(aggregate["low"]))
                        aggregate_close = Decimal(str(aggregate["close"]))
                        aggregate_volume = Decimal(str(aggregate["volume"]))
                    except (KeyError, InvalidOperation, TypeError, ValueError) as exc:
                        raise BacktestError(
                            "CHECKPOINT_CORRUPT",
                            "trade aggregate observation state is invalid",
                        ) from exc

            def aggregate_state() -> dict[str, object]:
                if aggregate_open is None:
                    return {}
                return {
                    "open": str(aggregate_open),
                    "high": str(aggregate_high),
                    "low": str(aggregate_low),
                    "close": str(aggregate_close),
                    "volume": str(aggregate_volume),
                }

            if checkpoint is None:
                self._save_trade_checkpoint(
                    record,
                    sequence=0,
                    observed=0,
                    aggregate_state={},
                    kernel=kernel,
                    session=session,
                    planner=planner,
                    event_bytes=event_bytes,
                )

            remaining_events = tuple(
                event for event in events if event.sequence > resume_sequence
            )
            last_order_count = len(kernel.orders)
            partial_seen = sum(order.status == "PARTIAL" for order in kernel.orders)

            def checkpoint_after(event: MarketEvent) -> None:
                nonlocal last_order_count, partial_seen
                order_count = len(kernel.orders)
                partial_count = sum(
                    order.status == "PARTIAL" for order in kernel.orders
                )
                interval = self.settings.checkpoint_event_interval
                periodic = interval > 0 and observed > 0 and observed % interval == 0
                fault_point = None
                if event.role == "FUNDING":
                    fault_point = "after_funding"
                elif partial_count > partial_seen:
                    fault_point = "after_partial_fill"
                elif order_count > last_order_count:
                    fault_point = "after_order"
                if periodic or (self._fault_injector is not None and fault_point):
                    self._save_trade_checkpoint(
                        record,
                        sequence=event.sequence,
                        observed=observed,
                        aggregate_state=aggregate_state(),
                        kernel=kernel,
                        session=session,
                        planner=planner,
                        event_bytes=event_bytes,
                    )
                last_order_count = order_count
                partial_seen = partial_count
                if fault_point is not None:
                    self._maybe_inject_fault(
                        fault_point, run_id=run_id, sequence=event.sequence
                    )

            result = kernel.run(
                remaining_events,
                strategy,
                warmup_events=0,
                finalize=True,
                checkpoint_callback=checkpoint_after,
            )
            cost_sensitivity = build_cost_sensitivity_matrix(kernel, events, result)
            metrics_market_context = _metrics_market_context(
                config, events, result.fills
            )
            self._assert_execution_control(
                run_id,
                deadline=deadline,
                expected_generation=expected_generation,
            )
            self._assert_provider_state_budget(session.snapshot())
            strategy_metadata = _provider_report_metadata(provider)
            final_sequence = events[-1].sequence if events else resume_sequence
            self._save_trade_checkpoint(
                record,
                sequence=final_sequence,
                observed=observed,
                aggregate_state=aggregate_state(),
                kernel=kernel,
                session=session,
                planner=planner,
                event_bytes=event_bytes,
            )
            self._maybe_inject_fault(
                "before_report_seal", run_id=run_id, sequence=final_sequence
            )
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
                    "name": (
                        TRADE_FILL_POLICY_V2
                        if kernel.execution_model_revision == EXECUTION_REALISM_V2
                        else "TRADE_NEXT_PRINT_CONSERVATIVE_V1"
                    ),
                    "slippage_bps": str(kernel.slippage_bps),
                    "taker_fee_bps": str(kernel.taker_fee_bps),
                    "maker_fee_bps": str(kernel.maker_fee_bps),
                    "funding_rate": str(kernel.funding_rate),
                    "funding_interval_hours": kernel.funding_interval_ms // 3_600_000,
                    "funding_model": (
                        str(config.get("funding_mode") or "OFF")
                        if str(config.get("account_model")) == "LINEAR_PERP_ONE_WAY_V2"
                        else (
                            "OFF" if kernel.funding_rate == 0 else "FIXED_INTERVAL_V1"
                        )
                    ),
                    **_execution_fill_model(config),
                },
                "cost_sensitivity": cost_sensitivity,
                "metrics_market_context": metrics_market_context,
            }
            | _policy_result_overrides(planner, result),
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
        config = json.loads(str(record["config_json"]))
        if config.get("study_protocol_revision") == STUDY_PROTOCOL_V2:
            folds = self.repository.list_study_folds(study_id)
            for fold in folds:
                fold["train_trials"] = self.repository.list_train_trials(
                    study_id, fold_id=str(fold["fold_id"])
                )
                receipt = self.repository.get_selection_receipt(str(fold["fold_id"]))
                fold["selection_receipt"] = (
                    None
                    if receipt is None
                    else json.loads(str(receipt["payload_json"]))
                )
                run_id = fold.get("test_run_id")
                fold["test_run"] = (
                    None if not run_id else self.repository.get_run_by_id(str(run_id))
                )
            holdout = self.repository.get_holdout(study_id)
            if holdout is not None and holdout.get("receipt_json"):
                holdout["receipt"] = json.loads(str(holdout["receipt_json"]))
            oos = self.repository.get_oos_report(study_id)
            record.update(
                {
                    "study_schema": STUDY_SCHEMA_V2,
                    "study_protocol_revision": STUDY_PROTOCOL_V2,
                    "identity": study_v2_identity(config),
                    "folds": folds,
                    "holdout": holdout,
                    "oos_report": (
                        None if oos is None else json.loads(str(oos["report_json"]))
                    ),
                    "dataset_basket": config.get("dataset_basket"),
                    "trials": [],
                }
            )
            return record
        record["trials"] = self.repository.list_trials(study_id)
        return record

    def list_studies(self) -> list[dict[str, object]]:
        return [
            self.get_study(str(record["study_id"]))
            for record in self.repository.list_studies()
        ]

    def compare_study(self, study_id: str) -> dict[str, object]:
        study = self.get_study(study_id)
        if study.get("study_protocol_revision") == STUDY_PROTOCOL_V2:
            oos = study.get("oos_report")
            config = json.loads(str(study["config_json"]))
            comparison = {
                "study_id": study_id,
                "ready": oos is not None,
                "completed_trial_count": sum(
                    len(fold.get("train_trials") or [])
                    for fold in study.get("folds") or []  # type: ignore[union-attr]
                ),
                "ranking": [],
                "folds": study.get("folds") or [],
                "oos_report": oos,
                "selection_warning": (
                    "train candidates select once; OOS contains TestRun only"
                ),
            }
            if config.get("dataset_basket"):
                comparison["dataset_basket"] = config["dataset_basket"]
                comparison["portfolio_sum_forbidden"] = True
                comparison["multi_market_enabled"] = False
                comparison["independent_symbol_robustness"] = (
                    self.evaluate_basket_reports(study_id)
                )
                comparison["selection_warning"] = (
                    "TRAIN symbols/windows select once; independent per-symbol "
                    "OOS is never summed as a portfolio"
                )
            return comparison
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

    def evaluate_basket_reports(
        self,
        study_id: str,
        member_reports: Sequence[Mapping[str, Any]] | None = None,
    ) -> dict[str, object]:
        study = self.get_study(study_id)
        config = json.loads(str(study["config_json"]))
        basket = config.get("dataset_basket")
        if not isinstance(basket, Mapping):
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "study has no dataset basket")
        folds = study.get("folds") or []
        fold_payload = None
        if folds:
            first = folds[0]
            fold_payload = {
                "ordinal": int(first["ordinal"]),
                "train_start_ms": int(first["train_start_ms"]),
                "train_end_ms": int(first["train_end_ms"]),
                "test_start_ms": int(first["test_start_ms"]),
                "test_end_ms": int(first["test_end_ms"]),
                "purge_ms": int(first.get("purge_ms") or 0),
                "embargo_ms": int(first.get("embargo_ms") or 0),
            }
        reports = (
            list(member_reports)
            if member_reports is not None
            else self._collect_basket_member_reports(study_id, basket)
        )
        robustness = build_basket_robustness(
            basket=basket,
            identity=study_v2_identity(config),
            member_reports=reports,
            seed=int(config.get("seed") or 1),
            fold_count=len(folds),
            fold=fold_payload,
            objective=str(config.get("objective") or "NET_RETURN"),
            constraints=config.get("constraints") or {},
        )
        robustness["plan"] = plan_independent_runs(
            basket,
            folds=[
                {
                    "ordinal": int(fold["ordinal"]),
                    "train_start_ms": int(fold["train_start_ms"]),
                    "train_end_ms": int(fold["train_end_ms"]),
                    "test_start_ms": int(fold["test_start_ms"]),
                    "test_end_ms": int(fold["test_end_ms"]),
                }
                for fold in folds
            ],
            holdout=int(config.get("holdout_ms") or 0) > 0,
        )
        return robustness

    def _collect_basket_member_reports(
        self, study_id: str, basket: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        members = {
            str(item["dataset_id"]): dict(item) for item in basket.get("members") or []
        }
        collected: list[dict[str, Any]] = []
        for run in self.repository.list_runs():
            if str(run.get("study_id") or "") != study_id:
                continue
            dataset_id = str(run.get("dataset_id") or "")
            member = members.get(dataset_id)
            if (
                member is None
                or str(run.get("state") or "") != RunState.COMPLETED.value
            ):
                continue
            stored = self.repository.get_report(str(run["run_id"]))
            if stored is None:
                continue
            report = json.loads(str(stored["report_json"]))
            try:
                run_config = json.loads(str(run.get("config_json") or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                run_config = {}
            sample_role = str(run_config.get("sample_role") or "")
            window_role = "TRAIN" if sample_role == "IN_SAMPLE" else "TEST"
            if member["role"] == "HOLDOUT" and sample_role == "OUT_OF_SAMPLE":
                window_role = "HOLDOUT"
            if window_role == "TRAIN":
                # Host compare overlay is OOS/robustness. TRAIN selection stays
                # on the sealed Study V2 receipt and cannot see TEST/HOLDOUT.
                continue
            performance = report.get("performance") or {}
            total_return = (performance.get("returns") or {}).get("total_return")
            if isinstance(total_return, Mapping):
                total_return = total_return.get("value")
            hashes = report.get("hashes") or {}
            scenarios = (report.get("cost_sensitivity") or {}).get("scenarios") or []
            plus_25 = next(
                (
                    item
                    for item in scenarios
                    if str(item.get("name")) == "COSTS_PLUS_25_PERCENT"
                ),
                None,
            )
            initial = _decimal_or_none(
                ((report.get("account") or {}).get("initial_balance"))
            )
            plus_equity = None
            if isinstance(plus_25, Mapping):
                plus_equity = _decimal_or_none(
                    ((plus_25.get("metrics") or {}).get("final_equity"))
                )
            collected.append(
                {
                    "dataset_id": dataset_id,
                    "window_role": window_role,
                    "role": member["role"],
                    "run_id": str(run["run_id"]),
                    "report_hash": str(
                        hashes.get("report") or stored.get("report_hash") or ""
                    ),
                    "report": report,
                    "test_objective": total_return,
                    "cost_sensitivity": report.get("cost_sensitivity"),
                    "fidelity_mode": str(run.get("fidelity_mode") or ""),
                    "decision_hash": hashes.get("decision"),
                    "fill_hash": hashes.get("fill"),
                    "cost_ok_base": _decimal_or_none(total_return) is not None
                    and _decimal_or_none(total_return) > 0,
                    "cost_ok_plus_25": (
                        plus_equity is not None
                        and initial is not None
                        and plus_equity > initial
                    ),
                }
            )
        return collected

    def _assert_flags(self, fidelity_mode: str) -> None:
        if not self.settings.enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_ENABLED is 0")
        if fidelity_mode == "BAR_APPROX" and not self.settings.bar_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_BAR_ENABLED is 0")
        if (
            fidelity_mode in {"TRADE_TAPE", "AGG_TRADE_TAPE", "AGG_TRADE_EXECUTION"}
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
            raise BacktestError(
                "RUN_CAPACITY_EXCEEDED",
                "active run ceiling reached",
                details={
                    "retryable": True,
                    "retry_after_ms": 1000,
                    "capacity": "active",
                },
            )
        queued = sum(state is RunState.QUEUED for state in states)
        queue_ceiling = self.settings.max_active_runs + (
            self.settings.max_concurrent_studies * self.settings.max_trials_per_study
        )
        if queued >= queue_ceiling:
            raise BacktestError(
                "RUN_CAPACITY_EXCEEDED",
                "queued run ceiling reached",
                details={
                    "retryable": True,
                    "retry_after_ms": 1000,
                    "capacity": "queued",
                },
            )

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
        account_model = str(payload.get("account_model") or "LINEAR_PERP_ONE_WAY_V1")
        if account_model not in {"LINEAR_PERP_ONE_WAY_V1", "LINEAR_PERP_ONE_WAY_V2"}:
            raise BacktestError("FIDELITY_UNSUPPORTED", "unsupported account model")
        if str(payload.get("gap_policy") or "REJECT") not in {
            "REJECT",
            "PAUSE",
            "SKIP_WITH_WARNING",
        }:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "unknown gap_policy")
        contract_data_mode = str(payload.get("contract_data_mode") or "LEGACY_FIXED_V1")
        if contract_data_mode not in {
            "LEGACY_FIXED_V1",
            "HISTORICAL_CONTRACT_V1",
        }:
            raise BacktestError("FIDELITY_UNSUPPORTED", "unknown contract_data_mode")
        funding_mode = str(payload.get("funding_mode") or "OFF")
        if funding_mode not in {"OFF", "FIXED_SCENARIO", "HISTORICAL_REQUIRED"}:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "unknown funding_mode")
        leverage = _config_decimal(payload, "leverage", "1")
        if leverage < 1 or leverage > 125:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "leverage must be 1..125")
        if (
            account_model == "LINEAR_PERP_ONE_WAY_V2"
            and contract_data_mode != "HISTORICAL_CONTRACT_V1"
        ):
            raise BacktestError(
                "DATA_ROLE_COVERAGE_MISSING",
                "LINEAR_PERP_ONE_WAY_V2 requires historical mark and instrument rules",
            )
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
                raise BacktestError(
                    "SCHEMA_UNKNOWN_FIELD", f"{name} cannot be negative"
                )
        funding_rate = _config_decimal(payload, "funding_rate", "0")
        if abs(funding_rate) > Decimal("1"):
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "funding_rate must be between -1 and 1"
            )
        if account_model == "LINEAR_PERP_ONE_WAY_V2":
            if funding_mode in {"OFF", "HISTORICAL_REQUIRED"} and funding_rate != 0:
                raise BacktestError(
                    "SCHEMA_UNKNOWN_FIELD",
                    f"{funding_mode} requires funding_rate=0",
                )
        try:
            funding_interval_hours = int(payload.get("funding_interval_hours") or 8)
        except (TypeError, ValueError) as exc:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "invalid funding_interval_hours"
            ) from exc
        if funding_interval_hours < 1 or funding_interval_hours > 168:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "funding_interval_hours must be 1..168"
            )
        output_mode = str(payload.get("output_mode") or "TARGET_POSITION")
        if output_mode not in {"SIGNAL", "TARGET_POSITION", "ORDER_INTENT"}:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "unsupported output_mode")
        try:
            host_policy = HostPolicyConfig.from_mapping(payload)
        except StrategyProviderError as exc:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", str(exc)) from exc
        quick_preset_id = str(payload.get("quick_preset_id") or "").strip()
        quick_preset_revision = str(payload.get("quick_preset_revision") or "").strip()
        fee_source = str(payload.get("fee_source") or "").strip()
        quick_fee_fields = ("taker_fee_bps", "maker_fee_bps", "slippage_bps")
        missing_quick_fee_fields = [
            name
            for name in quick_fee_fields
            if name not in payload or not str(payload.get(name) or "").strip()
        ]
        if quick_preset_id and (
            not quick_preset_revision or not fee_source or missing_quick_fee_fields
        ):
            raise BacktestError(
                "FEE_PRESET_UNKNOWN",
                "quick backtests require a versioned, confirmed fee preset",
                details={
                    "next_step": "select or confirm the market fee preset",
                    "missing_fields": missing_quick_fee_fields,
                },
            )
        strategy_source = payload.get("strategy_source")
        if strategy_source is not None and len(str(strategy_source)) > 2_000:
            raise BacktestError(
                "BUDGET_EXCEEDED", "strategy_source exceeds 2000 characters"
            )
        if self.enforce_registered_revisions:
            try:
                persisted_revision = self.repository.get_strategy_revision(
                    str(payload["strategy_revision_id"])
                )
                if persisted_revision is not None:
                    if persisted_revision["archived_at_ms"] is not None:
                        raise StrategyProviderError(
                            "IDENTITY_MUTATION",
                            "archived strategy revision cannot create a new Run",
                        )
                    smoke = self.repository.strategy_smoke_for_snapshot(
                        str(payload["strategy_revision_id"]),
                        str(payload["dataset_id"]),
                        str(payload["snapshot_hash"]),
                    )
                    if smoke is None:
                        raise StrategyProviderError(
                            "SMOKE_REQUIRED",
                            "run the bounded Strategy smoke for the selected immutable dataset snapshot before creating a Run",
                        )
                    base_revision = str(persisted_revision["base_revision_id"])
                    compiled_revision = json.loads(
                        str(persisted_revision["compiled_json"])
                    )
                    frozen_source = str(
                        compiled_revision.get("executionSource")
                        or persisted_revision["source_text"]
                    )
                    if base_revision == "python-source-v1":
                        smoke_details = json.loads(str(smoke["details_json"]))
                        requested_mode = str(
                            payload.get("python_runtime_mode") or "SANDBOXED_LOCAL"
                        )
                        if (
                            str(smoke_details.get("runtimeMode") or "")
                            != requested_mode
                        ):
                            raise StrategyProviderError(
                                "SMOKE_REQUIRED",
                                "rerun Strategy smoke for the selected python runtime mode",
                            )
                        persisted_capabilities = json.loads(
                            str(persisted_revision["capabilities_json"])
                        )
                        capabilities = type(
                            "PersistedCapabilities",
                            (),
                            {
                                "output_modes": tuple(
                                    persisted_capabilities.get("output_modes")
                                    or ("TARGET_POSITION",)
                                )
                            },
                        )()
                        probe = None
                    else:
                        probe = (
                            ChartPyneStrategyProvider()
                            if base_revision == CHART_PYNE_REVISION
                            else (
                                PineStrategyProvider()
                                if base_revision == "pine-long-flat-v1"
                                else build_builtin_provider(base_revision)
                            )
                        )
                        capabilities = probe.describe()
                    if (
                        strategy_source is not None
                        and str(strategy_source) != frozen_source
                    ):
                        raise StrategyProviderError(
                            "IDENTITY_MUTATION",
                            "Run cannot override frozen StrategyRevision source",
                        )
                    strategy_source = frozen_source
                else:
                    descriptor = self.strategy_registry.require(
                        str(payload["strategy_revision_id"])
                    )
                    capabilities = descriptor.factory().describe()
                    probe = descriptor.factory()
                if output_mode not in capabilities.output_modes:
                    raise StrategyProviderError(
                        "PROVIDER_PROTOCOL_VIOLATION",
                        f"strategy revision cannot output {output_mode}",
                    )
                if (
                    persisted_revision is None
                    and strategy_source is not None
                    and not descriptor.accepts_source
                ):
                    raise StrategyProviderError(
                        "PROVIDER_PROTOCOL_VIOLATION",
                        f"{descriptor.revision_id} does not accept strategy source",
                    )
                if probe is not None:
                    probe.prepare(
                        {
                            "roles": [
                                (
                                    "BARS"
                                    if fidelity in {"BAR_APPROX", "AGG_TRADE_EXECUTION"}
                                    else "TRADES"
                                )
                            ],
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
        signal_identity: dict[str, str | None] = {
            "signal_clock": None,
            "signal_interval": None,
            "execution_clock": None,
            "bar_builder": None,
            "timezone": None,
        }
        if fidelity == "AGG_TRADE_EXECUTION":
            interval = parse_interval_spec(
                str(payload.get("signal_interval") or payload.get("interval") or "")
            )
            if interval is None:
                raise BacktestError("SCHEMA_UNKNOWN_FIELD", "invalid signal_interval")
            expected_identity = {
                "signal_clock": SIGNAL_CLOCK,
                "execution_clock": EXECUTION_CLOCK,
                "bar_builder": BAR_BUILDER_REVISION,
                "timezone": BAR_TIMEZONE,
            }
            for name, expected in expected_identity.items():
                requested = str(payload.get(name) or expected)
                if requested != expected:
                    raise BacktestError(
                        "FIDELITY_UNSUPPORTED",
                        f"AGG_TRADE_EXECUTION requires {name}={expected}",
                    )
                signal_identity[name] = expected
            signal_identity["signal_interval"] = interval.canonical
            if str(payload.get("gap_policy") or "REJECT") != "REJECT":
                raise BacktestError(
                    "FIDELITY_UNSUPPORTED",
                    "AGG_TRADE_EXECUTION M2 requires gap_policy=REJECT",
                )
        try:
            execution_realism = parse_execution_realism(payload, fidelity_mode=fidelity)
        except MarketDatasetError as exc:
            raise BacktestError(exc.code, str(exc)) from exc
        try:
            metrics_identity = parse_metrics_identity(payload)
        except ValueError as exc:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", str(exc)) from exc
        if metrics_identity and (
            account_model != "LINEAR_PERP_ONE_WAY_V2"
            or execution_realism.revision != EXECUTION_REALISM_V2
        ):
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                "BACKTEST_METRICS_V2 requires LINEAR_PERP_ONE_WAY_V2 and EXECUTION_REALISM_V2",
            )
        execution_config = {
            "strategy_source": strategy_source,
            "output_mode": output_mode,
            "initial_balance": str(
                _config_decimal(payload, "initial_balance", "10000")
            ),
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
        for chart_field in ("symbol", "interval", "chart_range_mode"):
            if payload.get(chart_field) is not None:
                execution_config[chart_field] = str(payload[chart_field])
        if quick_preset_id:
            execution_config.update(
                {
                    "quick_preset_id": quick_preset_id,
                    "quick_preset_revision": quick_preset_revision,
                    "fee_source": fee_source,
                }
            )
        if "signal_trace_mode" in payload:
            trace_mode = str(payload.get("signal_trace_mode") or "LEGACY_INLINE_V1")
            if trace_mode not in {"LEGACY_INLINE_V1", "PAGED_V1"}:
                raise BacktestError("SCHEMA_UNKNOWN_FIELD", "unknown signal_trace_mode")
            execution_config["signal_trace_mode"] = trace_mode
        persisted_execution = self.repository.get_strategy_revision(
            str(payload["strategy_revision_id"])
        )
        if persisted_execution is not None:
            execution_config["strategy_execution_revision"] = str(
                persisted_execution["base_revision_id"]
            )
        if account_model == "LINEAR_PERP_ONE_WAY_V2":
            execution_config.update(
                {
                    "funding_mode": funding_mode,
                    "leverage": str(leverage),
                }
            )
        if host_policy is not None:
            execution_config.update(host_policy.identity())
        if fidelity == "AGG_TRADE_EXECUTION":
            execution_config.update(signal_identity)
        if contract_data_mode == "HISTORICAL_CONTRACT_V1":
            execution_config["contract_data_mode"] = contract_data_mode
        execution_config.update(execution_realism.identity(fidelity_mode=fidelity))
        execution_config.update(metrics_identity)
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
            account_model=account_model,
            execution_json=canonical_json(execution_config),
            **signal_identity,
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
            "schemaVersion": "candlescope.backtest-checkpoint/2",
            "checkpointMode": "BAR",
            "run_id": record["run_id"],
            "config_hash": record["config_hash"],
            "snapshot_hash": record["snapshot_hash"],
            "inputIdentity": self._checkpoint_input_identity(record),
            "sequence": int(sequence),
            "observed": int(observed),
            "engine": kernel.snapshot(),
            "provider": provider,
            "providerSnapshotCapable": bool(
                session.describe()["capabilities"]["snapshotRestore"]
            ),
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

    def _save_dual_clock_checkpoint(
        self,
        record: Mapping[str, object],
        *,
        sequence: int,
        kernel: DualClockSimulationKernel,
        session: StrategyProviderSession,
        planner: PyneHostPlanner,
        event_bytes: int,
    ) -> None:
        provider = session.snapshot()
        self._assert_provider_state_budget(provider)
        payload = {
            "schemaVersion": "candlescope.backtest-checkpoint/2",
            "checkpointMode": "DUAL_CLOCK",
            "run_id": record["run_id"],
            "config_hash": record["config_hash"],
            "snapshot_hash": record["snapshot_hash"],
            "inputIdentity": self._checkpoint_input_identity(record),
            "sequence": int(sequence),
            "observed": kernel.builder.signal_count,
            "engine": kernel.snapshot(),
            "provider": provider,
            "providerSnapshotCapable": bool(
                session.describe()["capabilities"]["snapshotRestore"]
            ),
            "planner": planner.snapshot(),
        }
        payload_json = canonical_json(payload)
        if event_bytes + len(payload_json.encode("utf-8")) > (
            self.settings.worker_memory_mb * 1024 * 1024
        ):
            raise BacktestError(
                "BUDGET_EXCEEDED",
                "dual-clock execution state exceeds worker memory ceiling",
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

    def _save_trade_checkpoint(
        self,
        record: Mapping[str, object],
        *,
        sequence: int,
        observed: int,
        aggregate_state: Mapping[str, object],
        kernel: TradeSimulationKernel,
        session: StrategyProviderSession,
        planner: PyneHostPlanner,
        event_bytes: int,
    ) -> None:
        provider = session.snapshot()
        self._assert_provider_state_budget(provider)
        payload = {
            "schemaVersion": "candlescope.backtest-checkpoint/2",
            "checkpointMode": "TRADE_TAPE",
            "run_id": record["run_id"],
            "config_hash": record["config_hash"],
            "snapshot_hash": record["snapshot_hash"],
            "inputIdentity": self._checkpoint_input_identity(record),
            "sequence": int(sequence),
            "observed": int(observed),
            "aggregateState": dict(aggregate_state),
            "engine": kernel.snapshot(),
            "provider": provider,
            "providerSnapshotCapable": bool(
                session.describe()["capabilities"]["snapshotRestore"]
            ),
            "planner": planner.snapshot(),
        }
        payload_json = canonical_json(payload)
        if event_bytes + len(payload_json.encode("utf-8")) > (
            self.settings.worker_memory_mb * 1024 * 1024
        ):
            raise BacktestError(
                "BUDGET_EXCEEDED",
                "trade execution state exceeds worker memory ceiling",
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

    @staticmethod
    def _checkpoint_input_identity(record: Mapping[str, object]) -> dict[str, object]:
        try:
            config = json.loads(str(record.get("config_json") or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise BacktestError(
                "CHECKPOINT_CORRUPT", "run configuration cannot be verified"
            ) from exc
        return {
            "strategyRevisionId": record.get("strategy_revision_id"),
            "datasetId": record.get("dataset_id"),
            "dataEpoch": record.get("data_epoch"),
            "snapshotHash": record.get("snapshot_hash"),
            "fidelityMode": record.get("fidelity_mode"),
            "sourceEventKind": record.get("source_event_kind"),
            "accountModel": config.get("account_model"),
            "contractDataMode": config.get("contract_data_mode"),
            "executionModelRevision": config.get("execution_model_revision"),
            "fillPolicy": config.get("fill_policy"),
            "strategyExecutionRevision": config.get("strategy_execution_revision"),
        }

    def _maybe_inject_fault(self, point: str, *, run_id: str, sequence: int) -> None:
        if self._fault_injector is None:
            return
        self._fault_injector(
            point,
            {"runId": run_id, "sequence": int(sequence), "schema": "BACKTEST_FAULT_V1"},
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
            raise BacktestError(
                "CHECKPOINT_CORRUPT", "checkpoint payload is invalid"
            ) from exc
        expected = "sha256:" + sha256_hex(payload)
        if str(checkpoint.get("state_hash") or "") != expected:
            raise BacktestError("CHECKPOINT_CORRUPT", "checkpoint hash mismatch")
        schema = payload.get("schemaVersion")
        if (
            schema
            not in {
                "candlescope.backtest-checkpoint/1",
                "candlescope.backtest-checkpoint/2",
            }
            or payload.get("run_id") != record.get("run_id")
            or payload.get("config_hash") != record.get("config_hash")
            or payload.get("snapshot_hash") != record.get("snapshot_hash")
            or payload.get("sequence") is None
            or int(payload["sequence"]) != int(checkpoint["sequence"])
            or int(checkpoint.get("generation") or 0) > int(record["generation"])
        ):
            raise BacktestError(
                "CHECKPOINT_CORRUPT",
                "checkpoint identity does not match the run",
            )
        if schema == "candlescope.backtest-checkpoint/2" and payload.get(
            "inputIdentity"
        ) != self._checkpoint_input_identity(record):
            raise BacktestError(
                "CHECKPOINT_CORRUPT",
                "checkpoint immutable input identity does not match the run",
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
        chart_interval: str | None = None,
        chart_bars: list[dict[str, object]] | None = None,
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
            signal_trace_rows: list[dict[str, object]] = []
            strategy_metadata = result_payload.get("strategy_metadata")
            completing_config = json.loads(str(completing["config_json"]))
            result_payload["trade_explanation_enabled"] = (
                self.settings.trade_explanation_effective
            )
            if isinstance(strategy_metadata, dict):
                raw_explanation_trace = strategy_metadata.pop(
                    "tradeExplanationTrace", None
                )
                if self.settings.trade_explanation_effective and isinstance(
                    raw_explanation_trace, list
                ):
                    result_payload["trade_explanation_trace"] = raw_explanation_trace
            if self.settings.trade_explanation_effective:
                revision = self.repository.get_strategy_revision(
                    str(completing["strategy_revision_id"])
                )
                result_payload["comparison_context"] = build_comparison_context(
                    run=completing,
                    config=completing_config,
                    provider_identity=(
                        result_payload.get("provider_identity")
                        if isinstance(result_payload.get("provider_identity"), Mapping)
                        else {}
                    ),
                    revision=revision,
                )
            if (
                isinstance(strategy_metadata, dict)
                and completing_config.get("signal_trace_mode") == "PAGED_V1"
            ):
                raw_trace = strategy_metadata.pop("decisionDebugTrace", None)
                if isinstance(raw_trace, list):
                    for ordinal, item in enumerate(raw_trace[:10_000], start=1):
                        if not isinstance(item, Mapping):
                            continue
                        payload_json = canonical_json(dict(item))
                        signal_trace_rows.append(
                            {
                                "ordinal": ordinal,
                                "event_time_ms": item.get("eventTimeMs"),
                                "payload_json": payload_json,
                                "row_hash": "sha256:" + sha256_hex(payload_json),
                            }
                        )
                    strategy_metadata["signalTrace"] = {
                        "schema": "SIGNAL_TRACE_V1",
                        "count": len(signal_trace_rows),
                        "hash": "sha256:"
                        + sha256_hex(
                            canonical_json(
                                [row["row_hash"] for row in signal_trace_rows]
                            )
                        ),
                        "paged": True,
                        "maxRows": 10_000,
                    }

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
                report_schema=str(report["schemaVersion"]),
                report_json=report_json,
                report_hash=report_hash,
                generated_at_ms=stamp,
                audit_action="complete",
                audit_actor="host",
                audit_details_json=canonical_json(audit_details),
                updated_at_ms=stamp,
                signal_trace_rows=signal_trace_rows,
                chart_cache=(
                    None
                    if chart_interval is None or chart_bars is None
                    else self._chart_cache_record(
                        chart_interval, chart_bars, generated_at_ms=stamp
                    )
                ),
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

    def _chart_cache_record(
        self,
        interval: str,
        bars: list[dict[str, object]],
        *,
        generated_at_ms: int,
    ) -> dict[str, object]:
        if len(bars) > 50_000:
            raise BacktestError(
                "BUDGET_EXCEEDED", "derived chart cache exceeds bounded bar ceiling"
            )
        bars_json = canonical_json(bars)
        if len(bars_json.encode("utf-8")) > self.settings.max_report_bytes:
            raise BacktestError(
                "BUDGET_EXCEEDED", "derived chart cache exceeds frozen byte ceiling"
            )
        return {
            "cache_schema": "BACKTEST_CHART_CACHE_V1",
            "interval": interval,
            "bars_json": bars_json,
            "bar_count": len(bars),
            "bars_hash": "sha256:" + sha256_hex(bars_json),
            "generated_at_ms": generated_at_ms,
        }

    def _normalize_execution_error(self, exc: Exception) -> Exception:
        if isinstance(exc, (BacktestError, StrategyProviderError, MarketDatasetError)):
            return exc
        if isinstance(exc, sqlite3.Error):
            return BacktestError(
                "BACKTEST_STORAGE_TRANSIENT",
                f"durable backtest storage failed ({type(exc).__name__})",
            )
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
            checkpoint = self.repository.latest_checkpoint(run_id)
            preserve = code in {
                "PROVIDER_TIMEOUT",
                "PROVIDER_CRASH_UNRECOVERABLE",
                "CHECKPOINT_CORRUPT",
                "DATASET_IDENTITY_CHANGED",
                "DATA_SNAPSHOT_MISMATCH",
                "DATA_GAP_REJECTED",
                "BACKTEST_STORAGE_TRANSIENT",
            }
            if not preserve:
                self.repository.delete_checkpoints(run_id)
            self._audit(
                run_id,
                "fail",
                {
                    "code": code,
                    "message": str(exc),
                    "checkpointPreserved": bool(preserve and checkpoint is not None),
                    "checkpointSequence": (
                        None if checkpoint is None else int(checkpoint["sequence"])
                    ),
                    "checkpointHash": (
                        None if checkpoint is None else str(checkpoint["state_hash"])
                    ),
                },
            )

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


def _execution_kernel_kwargs(config: Mapping[str, object]) -> dict[str, object]:
    if config.get("execution_model_revision") != EXECUTION_REALISM_V2:
        return {}
    return {
        "execution_model_revision": EXECUTION_REALISM_V2,
        "participation_rate": _config_decimal(config, "participation_rate", "0.1"),
        "latency_ms": int(config.get("latency_ms") or 0),
        "latency_events": int(config.get("latency_events") or 0),
        "order_end_policy": str(config.get("order_end_policy") or "CANCEL_AT_END"),
        "equity_curve_event_interval": int(
            config.get("equity_curve_event_interval") or 100
        ),
        "equity_curve_mode": (
            str(config["equity_curve_mode"])
            if config.get("equity_curve_mode") is not None
            else None
        ),
        **(
            {"bar_path_scenario": str(config["bar_path_scenario"])}
            if config.get("bar_path_scenario") is not None
            else {}
        ),
    }


def _execution_fill_model(config: Mapping[str, object]) -> dict[str, object]:
    if config.get("execution_model_revision") != EXECUTION_REALISM_V2:
        return {}
    return {
        "execution_model_revision": EXECUTION_REALISM_V2,
        "participation_rate": str(config.get("participation_rate")),
        "latency_ms": int(config.get("latency_ms") or 0),
        "latency_events": int(config.get("latency_events") or 0),
        "order_end_policy": str(config.get("order_end_policy")),
        "bar_path_scenario": config.get("bar_path_scenario"),
        "tif_supported": ["GTC", "IOC"],
        "equity_curve_event_interval": int(
            config.get("equity_curve_event_interval") or 100
        ),
    }


def _metrics_market_context(
    config: Mapping[str, object],
    events: tuple[MarketEvent, ...],
    fills: list[Mapping[str, object]],
) -> dict[str, object]:
    if config.get("metrics_version") is None:
        return {}
    return build_market_context(events, fills)


def _planning_context(kernel: Any, event: MarketEvent) -> PlanningContext:
    account = kernel.account
    reference = getattr(account, "mark", None)
    if reference is None:
        reference = event.payload.get("close", event.payload.get("price"))
    if reference is None:
        raise BacktestError(
            "DATA_ROLE_COVERAGE_MISSING", "Host policy requires a visible price"
        )
    quantity_step = getattr(account, "step", None) or getattr(kernel, "qty_step", None)
    min_notional = getattr(account, "min_notional", None) or getattr(
        kernel, "min_notional", None
    )
    contract_multiplier = getattr(account, "multiplier", None) or Decimal("1")
    active_orders = sum(order.status in {"OPEN", "PARTIAL"} for order in kernel.orders)
    cumulative_fees = getattr(account, "cumulative_fees", None)
    if cumulative_fees is None:
        cumulative_fees = getattr(kernel, "fee_total", Decimal("0"))
    return PlanningContext(
        sequence=event.sequence,
        event_time_ms=event.event_time_ms,
        actual_position=account.position_qty,
        projected_position=kernel.projected_position_qty,
        reference_price=Decimal(str(reference)),
        equity=account.equity(),
        initial_balance=kernel.initial_balance,
        cumulative_fees=Decimal(str(cumulative_fees)),
        leverage=Decimal(str(getattr(account, "leverage", kernel.leverage))),
        active_order_count=active_orders,
        quantity_step=quantity_step,
        min_notional=min_notional,
        contract_multiplier=Decimal(str(contract_multiplier)),
        rule_revision=str(getattr(account, "rule_version", None) or "LEGACY_CONFIG"),
        taker_fee_bps=kernel.taker_fee_bps,
        maker_fee_bps=kernel.maker_fee_bps,
    )


def _policy_result_overrides(
    planner: PyneHostPlanner, result: Any
) -> dict[str, object]:
    policy = planner.report()
    if not policy:
        return {}
    return {
        "rejected": [*result.rejected, *planner.rejections],
        "risk_policy": policy,
    }


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


def _event_wire_bytes(events: tuple[MarketEvent, ...]) -> int:
    """Count exact canonical list bytes without materializing a second event corpus."""
    total = 2
    for index, event in enumerate(events):
        if index:
            total += 1
        total += len(
            canonical_json(
                {
                    "sequence": event.sequence,
                    "event_time_ms": event.event_time_ms,
                    "role": event.role,
                    "payload": dict(event.payload),
                }
            ).encode("utf-8")
        )
    return total


def _now_ms() -> int:
    return int(time.time() * 1000)


def _decimal_or_none(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() else None
