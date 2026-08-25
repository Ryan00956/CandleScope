"""Source-neutral research identity contracts.

Frontend never invents snapshot_hash. Frozen context hash is derived from
backend-provided identity fields using canonical JSON + SHA-256.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal, Mapping

SOURCE_SCHEMA = "candlescope.research-source/1"
FROZEN_SCHEMA = "candlescope.frozen-research-context/1"
SOURCE_KINDS = ("CURRENT_CHART", "IMPORTED_DATASET", "COMPLETED_RUN")
SourceKind = Literal["CURRENT_CHART", "IMPORTED_DATASET", "COMPLETED_RUN"]
QualityStatus = Literal["ok", "gap", "failed"]

_ERROR_ACTIONS = {
    "INVALID_RESEARCH_SOURCE": "重新选择数据来源",
    "UNKNOWN_SOURCE_KIND": "重新选择数据来源",
    "MISSING_DATASET_IDENTITY": "重新选择本地资料库中的数据版本",
    "MISSING_SNAPSHOT_HASH": "从完成结果重新打开，不要手工填写身份",
    "INVALID_FROZEN_CONTEXT": "重新冻结数据后再运行",
    "CONTEXT_HASH_MISMATCH": "重新冻结数据后再运行",
    "FRONTEND_MUST_NOT_INVENT_SNAPSHOT": "等待后端返回已冻结身份",
}


class ResearchDataError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        action: str | None = None,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.action = action or _ERROR_ACTIONS.get(code, "重新选择来源")
        self.details = dict(details or {})

    def wire(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "code": self.code,
            "message": self.message,
            "action": self.action,
        }
        if self.details:
            payload["details"] = dict(self.details)
        return payload


def _require_mapping(value: object, code: str, message: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ResearchDataError(code, message)
    return dict(value)


def _require_str(values: Mapping[str, Any], key: str, *, code: str, label: str) -> str:
    raw = values.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise ResearchDataError(code, f"{label} is required")
    return raw.strip()


def _require_schema(values: Mapping[str, Any], expected: str, *, code: str) -> str:
    schema = _require_str(values, "schemaVersion", code=code, label="schemaVersion")
    if schema != expected:
        raise ResearchDataError(code, f"unsupported schemaVersion {schema!r}")
    return schema


def _require_int(values: Mapping[str, Any], key: str, *, code: str) -> int:
    raw = values.get(key)
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ResearchDataError(code, f"{key} must be an integer")
    return raw


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class CurrentChartSource:
    workspace_id: str
    cell_id: str
    exchange: str
    market_type: str
    symbol: str
    interval: str
    schema_version: str = SOURCE_SCHEMA
    kind: Literal["CURRENT_CHART"] = "CURRENT_CHART"


@dataclass(frozen=True, slots=True)
class ImportedDatasetSource:
    dataset_id: str
    data_epoch: str
    interval: str
    schema_version: str = SOURCE_SCHEMA
    kind: Literal["IMPORTED_DATASET"] = "IMPORTED_DATASET"


@dataclass(frozen=True, slots=True)
class CompletedRunSource:
    run_id: str
    dataset_id: str
    data_epoch: str
    snapshot_hash: str
    schema_version: str = SOURCE_SCHEMA
    kind: Literal["COMPLETED_RUN"] = "COMPLETED_RUN"


ResearchSourceRef = CurrentChartSource | ImportedDatasetSource | CompletedRunSource


@dataclass(frozen=True, slots=True)
class QualitySummary:
    status: QualityStatus
    rows: int
    excluded_range_count: int
    volume_available: bool

    def wire(self) -> dict[str, object]:
        return {
            "status": self.status,
            "rows": self.rows,
            "excludedRangeCount": self.excluded_range_count,
            "volumeAvailable": self.volume_available,
        }


@dataclass(frozen=True, slots=True)
class FrozenResearchContext:
    source_kind: SourceKind
    dataset_id: str
    data_epoch: str
    snapshot_hash: str
    interval: str
    start_time_ms: int
    end_time_ms: int
    symbol: str
    quality_summary: QualitySummary
    capability_summary: dict[str, Any]
    context_hash: str
    schema_version: str = FROZEN_SCHEMA

    def identity_wire(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "sourceKind": self.source_kind,
            "datasetId": self.dataset_id,
            "dataEpoch": self.data_epoch,
            "snapshotHash": self.snapshot_hash,
            "interval": self.interval,
            "startTimeMs": self.start_time_ms,
            "endTimeMs": self.end_time_ms,
            "symbol": self.symbol,
            "qualitySummary": self.quality_summary.wire(),
        }

    def wire(self) -> dict[str, object]:
        payload = self.identity_wire()
        payload["capabilitySummary"] = dict(self.capability_summary)
        payload["contextHash"] = self.context_hash
        return payload


def source_ref_wire(source: ResearchSourceRef) -> dict[str, object]:
    if isinstance(source, CurrentChartSource):
        return {
            "schemaVersion": source.schema_version,
            "kind": source.kind,
            "workspaceId": source.workspace_id,
            "cellId": source.cell_id,
            "exchange": source.exchange,
            "marketType": source.market_type,
            "symbol": source.symbol,
            "interval": source.interval,
        }
    if isinstance(source, ImportedDatasetSource):
        return {
            "schemaVersion": source.schema_version,
            "kind": source.kind,
            "datasetId": source.dataset_id,
            "dataEpoch": source.data_epoch,
            "interval": source.interval,
        }
    return {
        "schemaVersion": source.schema_version,
        "kind": source.kind,
        "runId": source.run_id,
        "datasetId": source.dataset_id,
        "dataEpoch": source.data_epoch,
        "snapshotHash": source.snapshot_hash,
    }


def parse_research_source_ref(value: object) -> ResearchSourceRef:
    values = _require_mapping(value, "INVALID_RESEARCH_SOURCE", "research source must be an object")
    _require_schema(values, SOURCE_SCHEMA, code="INVALID_RESEARCH_SOURCE")
    kind = values.get("kind")
    if not isinstance(kind, str) or kind not in SOURCE_KINDS:
        raise ResearchDataError(
            "UNKNOWN_SOURCE_KIND",
            "unknown research source kind",
            details={"kind": kind},
        )
    if kind == "CURRENT_CHART":
        return CurrentChartSource(
            workspace_id=_require_str(values, "workspaceId", code="INVALID_RESEARCH_SOURCE", label="workspaceId"),
            cell_id=_require_str(values, "cellId", code="INVALID_RESEARCH_SOURCE", label="cellId"),
            exchange=_require_str(values, "exchange", code="INVALID_RESEARCH_SOURCE", label="exchange"),
            market_type=_require_str(values, "marketType", code="INVALID_RESEARCH_SOURCE", label="marketType"),
            symbol=_require_str(values, "symbol", code="INVALID_RESEARCH_SOURCE", label="symbol"),
            interval=_require_str(values, "interval", code="INVALID_RESEARCH_SOURCE", label="interval"),
        )
    if kind == "IMPORTED_DATASET":
        dataset_id = values.get("datasetId")
        data_epoch = values.get("dataEpoch")
        if not isinstance(dataset_id, str) or not dataset_id.strip() or not isinstance(data_epoch, str) or not data_epoch.strip():
            raise ResearchDataError(
                "MISSING_DATASET_IDENTITY",
                "imported data requires dataset and data version from the library",
            )
        return ImportedDatasetSource(
            dataset_id=dataset_id.strip(),
            data_epoch=data_epoch.strip(),
            interval=_require_str(values, "interval", code="INVALID_RESEARCH_SOURCE", label="interval"),
        )
    snapshot = values.get("snapshotHash")
    if not isinstance(snapshot, str) or not snapshot.strip():
        raise ResearchDataError(
            "MISSING_SNAPSHOT_HASH",
            "completed results require a backend snapshot hash",
        )
    return CompletedRunSource(
        run_id=_require_str(values, "runId", code="INVALID_RESEARCH_SOURCE", label="runId"),
        dataset_id=_require_str(values, "datasetId", code="MISSING_DATASET_IDENTITY", label="datasetId"),
        data_epoch=_require_str(values, "dataEpoch", code="MISSING_DATASET_IDENTITY", label="dataEpoch"),
        snapshot_hash=snapshot.strip(),
    )


def parse_quality_summary(value: object) -> QualitySummary:
    values = _require_mapping(value, "INVALID_FROZEN_CONTEXT", "qualitySummary must be an object")
    status = values.get("status")
    if status not in {"ok", "gap", "failed"}:
        raise ResearchDataError("INVALID_FROZEN_CONTEXT", "unknown quality status")
    rows = _require_int(values, "rows", code="INVALID_FROZEN_CONTEXT")
    excluded = _require_int(values, "excludedRangeCount", code="INVALID_FROZEN_CONTEXT")
    volume = values.get("volumeAvailable")
    if not isinstance(volume, bool):
        raise ResearchDataError("INVALID_FROZEN_CONTEXT", "volumeAvailable must be a boolean")
    if rows < 0 or excluded < 0:
        raise ResearchDataError("INVALID_FROZEN_CONTEXT", "quality counts cannot be negative")
    return QualitySummary(
        status=status,
        rows=rows,
        excluded_range_count=excluded,
        volume_available=volume,
    )


def frozen_context_canonical_json(
    *,
    schema_version: str,
    source_kind: str,
    dataset_id: str,
    data_epoch: str,
    snapshot_hash: str,
    interval: str,
    start_time_ms: int,
    end_time_ms: int,
    symbol: str,
    quality_summary: QualitySummary,
) -> str:
    return canonical_json(
        {
            "schemaVersion": schema_version,
            "sourceKind": source_kind,
            "datasetId": dataset_id,
            "dataEpoch": data_epoch,
            "snapshotHash": snapshot_hash,
            "interval": interval,
            "startTimeMs": start_time_ms,
            "endTimeMs": end_time_ms,
            "symbol": symbol,
            "qualitySummary": quality_summary.wire(),
        }
    )


def frozen_context_hash(canonical: str) -> str:
    return "sha256:" + sha256_hex(canonical)


def assemble_frozen_research_context(
    values: Mapping[str, Any],
    *,
    capability_summary: Mapping[str, Any],
    snapshot_hash: str | None = None,
) -> FrozenResearchContext:
    """Assemble a frozen context from backend-provided identity.

    ``snapshot_hash`` must come from backend preview/materialize. Passing None
    is rejected so callers cannot silently invent one.
    """
    schema = str(values.get("schemaVersion") or FROZEN_SCHEMA)
    if schema != FROZEN_SCHEMA:
        raise ResearchDataError("INVALID_FROZEN_CONTEXT", f"unsupported schemaVersion {schema!r}")
    source_kind = values.get("sourceKind")
    if source_kind not in SOURCE_KINDS:
        raise ResearchDataError("UNKNOWN_SOURCE_KIND", "unknown frozen source kind")
    provided_snapshot = snapshot_hash if snapshot_hash is not None else values.get("snapshotHash")
    if not isinstance(provided_snapshot, str) or not provided_snapshot.strip():
        raise ResearchDataError(
            "FRONTEND_MUST_NOT_INVENT_SNAPSHOT",
            "snapshot hash must come from the backend freeze step",
        )
    quality = parse_quality_summary(values.get("qualitySummary"))
    start_ms = _require_int(values, "startTimeMs", code="INVALID_FROZEN_CONTEXT")
    end_ms = _require_int(values, "endTimeMs", code="INVALID_FROZEN_CONTEXT")
    if end_ms < start_ms:
        raise ResearchDataError("INVALID_FROZEN_CONTEXT", "endTimeMs must be >= startTimeMs")
    canonical = frozen_context_canonical_json(
        schema_version=schema,
        source_kind=str(source_kind),
        dataset_id=_require_str(values, "datasetId", code="MISSING_DATASET_IDENTITY", label="datasetId"),
        data_epoch=_require_str(values, "dataEpoch", code="MISSING_DATASET_IDENTITY", label="dataEpoch"),
        snapshot_hash=provided_snapshot.strip(),
        interval=_require_str(values, "interval", code="INVALID_FROZEN_CONTEXT", label="interval"),
        start_time_ms=start_ms,
        end_time_ms=end_ms,
        symbol=_require_str(values, "symbol", code="INVALID_FROZEN_CONTEXT", label="symbol"),
        quality_summary=quality,
    )
    context_hash = frozen_context_hash(canonical)
    declared = values.get("contextHash")
    if isinstance(declared, str) and declared.strip() and declared.strip() != context_hash:
        raise ResearchDataError("CONTEXT_HASH_MISMATCH", "frozen context hash does not match identity")
    return FrozenResearchContext(
        source_kind=source_kind,  # type: ignore[arg-type]
        dataset_id=str(values["datasetId"]).strip(),
        data_epoch=str(values["dataEpoch"]).strip(),
        snapshot_hash=provided_snapshot.strip(),
        interval=str(values["interval"]).strip(),
        start_time_ms=start_ms,
        end_time_ms=end_ms,
        symbol=str(values["symbol"]).strip(),
        quality_summary=quality,
        capability_summary=dict(capability_summary),
        context_hash=context_hash,
        schema_version=schema,
    )


def parse_frozen_research_context(value: object) -> FrozenResearchContext:
    values = _require_mapping(value, "INVALID_FROZEN_CONTEXT", "frozen research context must be an object")
    capability = values.get("capabilitySummary")
    if not isinstance(capability, Mapping):
        raise ResearchDataError("INVALID_FROZEN_CONTEXT", "capabilitySummary must be an object")
    return assemble_frozen_research_context(values, capability_summary=capability)
