from __future__ import annotations

import json
from pathlib import Path

from app.replay.canonical import canonical_sha256


ROOT = Path(__file__).resolve().parents[2]
BASELINE = (
    ROOT
    / "docs"
    / "perf-baselines"
    / "replay-v2-account-history-20260726.json"
)


def test_positioned_exact_account_capacity_evidence_covers_1_2_4_8_full_tracks(
) -> None:
    report = json.loads(BASELINE.read_text(encoding="utf-8"))

    assert report["schema_version"] == "replay.phase16.account-history-capacity.v1"
    assert report["acceptance"] == {"passed": True, "decision": "PASS"}
    assert report["checks"] == {
        "all_semantic_checks_pass": True,
        "all_p95_within_frozen_ceiling": True,
        "all_rss_within_frozen_ceiling": True,
    }
    cases = report["cases"]
    assert [case["track_count"] for case in cases] == [1, 2, 4, 8]
    assert all(
        case["position_count"] == case["track_count"]
        and all(case["checks"].values())
        and case["step_ms"]["p95"]
        <= report["frozen_limits"]["max_step_p95_ms"]
        for case in cases
    )
    semantic_evidence = [
        {
            "track_count": case["track_count"],
            "position_count": case["position_count"],
            "global_event_count": case["global_event_count"],
            "account_audit_proof_hash": case["account_audit_proof_hash"],
            "account_archive_proof_hash": case["account_archive_proof_hash"],
            "checks": case["checks"],
        }
        for case in cases
    ]
    assert report["evidence_hash"] == canonical_sha256(semantic_evidence)
