from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app.replay.canonical import canonical_sha256
from app.replay.training.models import REPLAY_V2_PROTOCOL
from scripts.benchmark_replay_account_history import _request, run_benchmark
from tests.fixtures.replay.account_history import build_account_history_archive


ROOT = Path(__file__).resolve().parents[2]
BASELINE = (
    ROOT
    / "docs"
    / "perf-baselines"
    / "replay-v2-account-history-20260726.json"
)


def test_account_history_benchmark_uses_current_training_wire_protocol() -> None:
    request = _request(
        catalog_epoch="sha256:" + "0" * 64,
        forward_cache_ms=60_000,
        account_history_ref=None,
    )

    assert request.protocol == REPLAY_V2_PROTOCOL == "replay.v3"
    assert request.position_mode.value == "ONE_WAY"


def test_account_history_fixture_releases_its_sqlite_source(tmp_path: Path) -> None:
    archive = tmp_path / "account-history.sqlite3"
    range_start_ms = 1_700_000_040_000
    build_account_history_archive(
        archive,
        range_start_ms=range_start_ms,
        range_end_ms=range_start_ms + 10 * 60_000,
    )

    archive.unlink()
    assert not archive.exists()


def test_account_history_benchmark_checks_authoritative_funding_state() -> None:
    source = (
        ROOT / "backend" / "scripts" / "benchmark_replay_account_history.py"
    ).read_text(encoding="utf-8")

    assert 'projection["portfolio"]["funding_cashflow"]' in source
    assert "replay_training_funding_settlement" in source
    assert 'projection["portfolio"]["ledger"]["entries"]' not in source


def test_account_history_benchmark_releases_all_temporary_databases(
    tmp_path: Path,
) -> None:
    report = asyncio.run(
        run_benchmark(iterations=3, temporary_storage_root=tmp_path)
    )

    assert [case["track_count"] for case in report["cases"]] == [1, 2, 4, 8]
    assert list(tmp_path.iterdir()) == []


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
