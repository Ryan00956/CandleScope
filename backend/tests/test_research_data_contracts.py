from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.research_data.capabilities import (
    is_capability_available,
    project_capabilities,
)
from app.research_data.contracts import (
    ResearchDataError,
    assemble_frozen_research_context,
    canonical_json,
    frozen_context_canonical_json,
    frozen_context_hash,
    parse_frozen_research_context,
    parse_quality_summary,
    parse_research_source_ref,
    source_ref_wire,
)


FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "research_data" / "canonical-v1.json"


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_canonical_fixture_parses_all_source_kinds() -> None:
    fixture = _fixture()
    for name, payload in fixture["sourceRefs"].items():
        parsed = parse_research_source_ref(payload)
        assert parsed.kind in {"CURRENT_CHART", "IMPORTED_DATASET", "COMPLETED_RUN"}
        assert canonical_json(source_ref_wire(parsed)) == canonical_json(payload)
        assert name  # names exist so the loop is not empty


@pytest.mark.parametrize(
    "case_name",
    ["imported-missing-dataset", "imported-missing-epoch", "completed-missing-snapshot", "unknown-kind"],
)
def test_canonical_invalid_sources_fail_closed(case_name: str) -> None:
    case = next(item for item in _fixture()["invalid"] if item["name"] == case_name)
    with pytest.raises(ResearchDataError) as raised:
        parse_research_source_ref(case["source"])
    assert raised.value.code == case["code"]
    assert raised.value.action
    assert "traceback" not in json.dumps(raised.value.wire()).lower()


def test_assemble_frozen_context_hashes_backend_snapshot_without_inventing_it() -> None:
    freeze_input = _fixture()["freezeInputs"]["importedDataset"]
    quality = parse_quality_summary(freeze_input["qualitySummary"])
    capabilities = project_capabilities("IMPORTED_DATASET", quality=quality).wire()
    frozen = assemble_frozen_research_context(
        freeze_input,
        capability_summary=capabilities,
        snapshot_hash=freeze_input["snapshotHash"],
    )
    expected_canonical = frozen_context_canonical_json(
        schema_version=freeze_input["schemaVersion"],
        source_kind=freeze_input["sourceKind"],
        dataset_id=freeze_input["datasetId"],
        data_epoch=freeze_input["dataEpoch"],
        snapshot_hash=freeze_input["snapshotHash"],
        interval=freeze_input["interval"],
        start_time_ms=freeze_input["startTimeMs"],
        end_time_ms=freeze_input["endTimeMs"],
        symbol=freeze_input["symbol"],
        quality_summary=quality,
    )
    assert frozen.context_hash == frozen_context_hash(expected_canonical)
    assert frozen.snapshot_hash == freeze_input["snapshotHash"]
    parsed = parse_frozen_research_context(frozen.wire())
    assert parsed.context_hash == frozen.context_hash


def test_missing_snapshot_hash_is_not_invented() -> None:
    freeze_input = dict(_fixture()["freezeInputs"]["importedDataset"])
    freeze_input.pop("snapshotHash")
    with pytest.raises(ResearchDataError) as raised:
        assemble_frozen_research_context(freeze_input, capability_summary={})
    assert raised.value.code == "FRONTEND_MUST_NOT_INVENT_SNAPSHOT"


def test_capability_absence_is_unavailable_not_true() -> None:
    quality = parse_quality_summary(_fixture()["freezeInputs"]["importedDataset"]["qualitySummary"])
    summary = project_capabilities("IMPORTED_DATASET", quality=quality)
    assert is_capability_available(summary, "barApprox") is True
    assert is_capability_available(summary, "tradeTape") is False
    assert summary.fidelity_ceiling == "BAR_APPROX"
    assert is_capability_available({"capabilities": {}}, "barApprox") is False
    assert is_capability_available({}, "viewKlines") is False
    stripped = summary.wire()
    stripped["capabilities"].pop("barApprox")
    assert is_capability_available(stripped, "barApprox") is False


def test_imported_dataset_never_advertises_online_backfill() -> None:
    summary = project_capabilities("IMPORTED_DATASET", runtime_mode="LIVE")
    decision = summary.capabilities["onlineBackfill"]
    assert decision.available is False
    assert decision.reason_code == "IMPORTED_DATASET_NEVER_NETWORKS"


def test_offline_hides_current_chart_run() -> None:
    summary = project_capabilities("CURRENT_CHART", runtime_mode="LOCAL_OFFLINE")
    assert is_capability_available(summary, "barApprox") is False
    assert summary.capabilities["barApprox"].reason_code == "OFFLINE_LIVE_SOURCE_UNAVAILABLE"


def test_ordinary_error_payload_has_action_and_no_internal_path() -> None:
    with pytest.raises(ResearchDataError) as raised:
        parse_research_source_ref({"schemaVersion": "candlescope.research-source/1", "kind": "NOPE"})
    payload = raised.value.wire()
    serialized = json.dumps(payload)
    assert payload["action"]
    assert "H:\\" not in serialized
    assert "/home/" not in serialized
    assert "traceback" not in serialized.lower()
