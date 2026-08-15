"""Fail-closed StrategyRevision V2 compiler; never executes user code."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Mapping

from app.backtest.strategy.builtin import (
    BUILTIN_ORDER_COMMAND_REVISION,
    BUILTIN_RSI_WILDER_LONG_SHORT_REVISION,
    build_builtin_provider,
)
from app.backtest.strategy.pine_adapter import MATRIX_VERSION, analyze_pine_strategy
from app.backtest.strategy.protocol import StrategyProviderError, canonical_hash

STRATEGY_REVISION_SCHEMA = "STRATEGY_REVISION_V2"
COMPILE_RECEIPT_SCHEMA = "STRATEGY_COMPILE_RECEIPT_V2"
RUNTIME_REVISION = "candlescope-strategy-workspace/2"
LANGUAGES = frozenset(
    {
        "BUILTIN_TEMPLATE",
        "PINE_SUBSET",
        "PYNE_ORDER_DSL",
        "EXTERNAL_ARTIFACT_REF",
        "PYTHON_SOURCE",
    }
)


def _diagnostic(source: str, token: str, message: str) -> dict[str, object]:
    offset = max(0, source.lower().find(token.lower()))
    line = source.count("\n", 0, offset) + 1
    column = offset - source.rfind("\n", 0, offset)
    return {
        "severity": "ERROR",
        "line": line,
        "column": column,
        "message": message,
        "next_step": "remove the unsupported construct and compile again",
    }


def compile_revision(payload: Mapping[str, object], *, now_ms: int) -> dict[str, Any]:
    language = str(payload.get("language") or "BUILTIN_TEMPLATE").upper()
    if language not in LANGUAGES:
        raise StrategyProviderError(
            "FIDELITY_UNSUPPORTED", f"unsupported strategy language {language}"
        )
    name = str(payload.get("name") or "").strip()
    if not name:
        raise StrategyProviderError("SCHEMA_UNKNOWN_FIELD", "strategy name is required")
    source = str(payload.get("source_text") or "")
    parameters = payload.get("parameter_schema") or []
    python_output_modes = ["TARGET_POSITION"]
    python_required_features: list[object] = []
    python_warmup: dict[str, object] = {}
    if not isinstance(parameters, list):
        raise StrategyProviderError(
            "SCHEMA_UNKNOWN_FIELD", "parameter_schema must be a list"
        )
    diagnostics: list[dict[str, object]] = []
    if language == "BUILTIN_TEMPLATE":
        base = str(
            payload.get("base_revision_id") or BUILTIN_RSI_WILDER_LONG_SHORT_REVISION
        )
        if base != BUILTIN_RSI_WILDER_LONG_SHORT_REVISION:
            raise StrategyProviderError(
                "FIDELITY_UNSUPPORTED",
                "M9 builtin template supports the frozen Wilder RSI revision",
            )
    elif language == "PINE_SUBSET":
        rejected = analyze_pine_strategy(source)
        diagnostics = [
            _diagnostic(source, token, f"{token} is outside {MATRIX_VERSION}")
            for token in rejected
        ]
        if not source.strip():
            diagnostics.append(_diagnostic(source, "", "Pine source is required"))
        if diagnostics:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                json.dumps(diagnostics, ensure_ascii=False),
            )
        # The current safe Pine subset has one frozen interpreter identity.
        base = "pine-long-flat-v1"
    elif language == "PYNE_ORDER_DSL":
        base = BUILTIN_ORDER_COMMAND_REVISION
        try:
            probe = build_builtin_provider(base)
            probe.prepare(
                {"source": source, "parameters": {}, "outputMode": "ORDER_INTENT"}
            )
            probe.close()
        except StrategyProviderError as exc:
            diagnostics.append(_diagnostic(source, "", str(exc)))
            raise StrategyProviderError(
                exc.code, json.dumps(diagnostics, ensure_ascii=False)
            ) from exc
    elif language == "PYTHON_SOURCE":
        try:
            artifact = json.loads(source)
        except json.JSONDecodeError as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                json.dumps(
                    [_diagnostic(source, "", "PYTHON_SOURCE identity must be JSON")]
                ),
            ) from exc
        required = {
            "bundle_id",
            "bundle_hash",
            "manifest_hash",
            "source_hash",
            "sdk_hash",
            "entrypoint",
            "signalClock",
        }
        if not isinstance(artifact, dict) or not required.issubset(artifact):
            raise StrategyProviderError(
                "SCHEMA_UNKNOWN_FIELD",
                "PYTHON_SOURCE revision is missing frozen bundle identity",
            )
        if artifact.get("signalClock") != "BAR_CLOSE":
            raise StrategyProviderError(
                "FIDELITY_UNSUPPORTED",
                "PYTHON_SOURCE first edition only supports BAR_CLOSE",
            )
        python_output_modes = list(artifact.get("outputModes") or ["TARGET_POSITION"])
        python_required_features = list(artifact.get("requiredFeatures") or [])
        warmup = artifact.get("warmup") or {}
        python_warmup = warmup if isinstance(warmup, dict) else {}
        base = "python-source-v1"
    else:
        try:
            artifact = json.loads(source)
        except json.JSONDecodeError as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                json.dumps(
                    [
                        _diagnostic(
                            source, "", "external artifact reference must be JSON"
                        )
                    ]
                ),
            ) from exc
        required = {
            "model_artifact_id",
            "artifact_hash",
            "format",
            "runtime_lock",
            "feature_schema",
            "recorded_expression",
        }
        if not isinstance(artifact, dict) or not required.issubset(artifact):
            raise StrategyProviderError(
                "SCHEMA_UNKNOWN_FIELD",
                "external artifact reference is missing frozen identity fields",
            )
        if (
            any(key in artifact for key in ("train", "fit", "overwrite"))
            or artifact.get("allow_network") is True
        ):
            raise StrategyProviderError(
                "PROVIDER_UNAUTHORIZED_WRITE",
                "Run may only reference a frozen offline artifact; training, overwrite and network are forbidden",
            )
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(artifact["artifact_hash"])):
            raise StrategyProviderError(
                "DATA_SNAPSHOT_MISMATCH",
                "artifact_hash must be a complete sha256 identity",
            )
        base = "builtin-expression-model-v1"

    source_hash = canonical_hash({"language": language, "source": source})
    dependency_hash = canonical_hash(
        {"baseRevision": base, "runtime": RUNTIME_REVISION}
    )
    compiled = {
        "schema": COMPILE_RECEIPT_SCHEMA,
        "language": language,
        "baseRevisionId": base,
        "sourceHash": source_hash,
        "dependencyHash": dependency_hash,
        "runtimeRevision": RUNTIME_REVISION,
        "tradingViewEquivalent": False if language == "PINE_SUBSET" else None,
        "executionSource": (
            artifact["recorded_expression"]
            if language == "EXTERNAL_ARTIFACT_REF"
            else source
        ),
    }
    compiled_hash = canonical_hash(compiled)
    revision_id = "srv2_" + uuid.uuid4().hex
    provider = (
        None
        if base in {"pine-long-flat-v1", "python-source-v1"}
        else build_builtin_provider(base)
    )
    capabilities = (
        {
            "input_modes": list(provider.describe().input_modes),
            "output_modes": list(provider.describe().output_modes),
            "signal_clock": provider.describe().signal_clock,
            "unsupported": [
                "arbitrary code",
                "network access",
                "training during Run",
                "artifact overwrite",
            ],
        }
        if provider is not None
        else {
            "input_modes": ["BAR_CLOSE"],
            "output_modes": python_output_modes if language == "PYTHON_SOURCE" else ["TARGET_POSITION"],
            "signal_clock": "BAR_CLOSE" if language == "PYTHON_SOURCE" else "EVENT_TIME",
            "required_features": python_required_features,
            "warmup_requirement": python_warmup,
            "unsupported": [
                "network access",
                "raw trade",
                "queue exact",
                "intrabar unique path",
                "Host order/fill/report ownership by strategy",
            ]
            if language == "PYTHON_SOURCE"
            else [
                "TradingView equivalence",
                "short/pyramiding",
                "network access",
            ],
        }
    )
    return {
        "revision_id": revision_id,
        "schema_version": STRATEGY_REVISION_SCHEMA,
        "name": name,
        "language": language,
        "base_revision_id": base,
        "source_text": source,
        "source_hash": source_hash,
        "compiled_json": json.dumps(compiled, sort_keys=True, separators=(",", ":")),
        "compiled_hash": compiled_hash,
        "dependency_hash": dependency_hash,
        "runtime_revision": RUNTIME_REVISION,
        "parameter_schema_json": json.dumps(
            parameters, sort_keys=True, separators=(",", ":")
        ),
        "capabilities_json": json.dumps(
            capabilities, sort_keys=True, separators=(",", ":")
        ),
        "archived_at_ms": None,
        "created_at_ms": now_ms,
        "diagnostics": diagnostics,
    }


def parse_compile_diagnostics(exc: StrategyProviderError) -> list[dict[str, object]]:
    try:
        parsed = json.loads(str(exc))
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []
