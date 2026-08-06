from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest

from app.core.config import load_replay_settings
from scripts import replay_v2_release_common as release_common
from scripts import verify_replay_v2_release as release_verifier
from scripts.benchmark_replay_fast_forward import _run_mode


ROOT = Path(__file__).resolve().parents[2]


def test_phase10_maps_every_product_contract_scenario_to_live_evidence() -> None:
    matrix, validated = release_verifier._validate_matrix()
    assert matrix["production_enablement"] == "HARD_CUTOVER_DEFAULT_ON"
    assert matrix["expected_scenarios"] == 40
    assert [scenario["id"] for scenario in validated] == list(range(1, 41))
    assert all(scenario["validated"] is True for scenario in validated)
    assert {scenario["release_gate"] for scenario in validated} == {
        "full_suite",
        "browser",
        "benchmark",
        "soak",
        "rollback",
        "storage",
        "real_source",
    }


def test_phase10_keeps_replay_and_exact_input_capabilities_default_on(
    tmp_path: Path,
) -> None:
    settings = load_replay_settings(
        {}, data_dir=tmp_path, klines_db_path=tmp_path / "candlescope.db"
    )
    assert settings.enabled is True
    assert settings.replay_historical_book_enabled is True
    assert release_verifier._validate_default_flags() == {
        "REPLAY_ENABLED": "1",
        "RAW_AGG_TRADE_ARCHIVE_ENABLED": "0",
        "REPLAY_HISTORICAL_BOOK_ENABLED": "1",
        "REPLAY_SEGMENT_DOWNLOAD_WORKER_ENABLED": "0",
        "REPLAY_SEGMENT_AUTO_GC_ENABLED": "0",
        "REPLAY_FAST_FORWARD_OPTIMIZATION_ENABLED": "0",
        "REPLAY_ACCOUNT_HISTORY_ENABLED": "1",
    }


def test_release_artifacts_must_be_external_and_partitioned_by_full_head(
    tmp_path: Path,
) -> None:
    head = "a" * 40
    accepted = release_common.require_external_head_path(
        tmp_path / head / "replay-v2" / "checks.json", head
    )
    assert accepted.is_absolute()
    with pytest.raises(ValueError, match="full clean Git HEAD"):
        release_common.require_external_head_path(tmp_path / "checks.json", head)
    with pytest.raises(ValueError, match="outside the repository"):
        release_common.require_external_head_path(
            ROOT / "output" / head / "checks.json", head
        )


def test_windows_npm_command_resolves_path_batch_shim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    npm_cmd = r"F:\node\npm.cmd"
    monkeypatch.setattr(release_common.shutil, "which", lambda value: npm_cmd)

    assert release_common._resolve_windows_command("npm") == npm_cmd
    assert release_common._resolve_windows_command(r"C:\explicit\npm.cmd") == (
        r"C:\explicit\npm.cmd"
    )
    if release_common.os.name == "nt":
        assert release_common.npm_command("npm", "run", "check") == [
            release_common.os.environ.get("ComSpec", "cmd.exe"),
            "/d",
            "/s",
            "/c",
            subprocess.list2cmdline([npm_cmd, "run", "check"]),
        ]


def test_bound_json_rejects_wrong_head_schema_dirty_or_failed(tmp_path: Path) -> None:
    path = tmp_path / "artifact.json"
    valid = {
        "schema_version": "expected.v1",
        "release_evidence": {
            "schema_version": "replay-release-evidence.v1",
            "git_head": "a" * 40,
            "git_dirty": False,
        },
        "passed": True,
    }
    path.write_text(json.dumps(valid), encoding="utf-8")
    payload, evidence = release_common.load_bound_json(
        path, expected_head="a" * 40, expected_schema="expected.v1"
    )
    assert payload["passed"] is True
    assert evidence["sha256"]

    for field, value, message in (
        ("schema_version", "wrong.v1", "schema drifted"),
        (
            "release_evidence",
            {**valid["release_evidence"], "git_head": "b" * 40},
            "not bound",
        ),
        (
            "release_evidence",
            {**valid["release_evidence"], "git_dirty": True},
            "not captured",
        ),
        ("passed", False, "not a passing"),
    ):
        mutated = dict(valid)
        mutated[field] = value
        path.write_text(json.dumps(mutated), encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            release_common.load_bound_json(
                path, expected_head="a" * 40, expected_schema="expected.v1"
            )


def test_phase10_revert_drill_resolves_the_phase_first_parent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    head = "a" * 40
    calls: list[tuple[str, ...]] = []

    def fake_run_git(*args: str, **_kwargs: object) -> str:
        calls.append(args)
        return "B" * 40

    monkeypatch.setattr(release_verifier, "run_git", fake_run_git)

    assert release_verifier._resolve_phase_parent(head) == "b" * 40
    assert calls == [("rev-parse", "--verify", f"{head}^")]


def test_phase10_browser_and_rollback_tools_expose_frozen_v2_gates() -> None:
    smoke = (ROOT / "frontend/scripts/replay-smoke.mjs").read_text(encoding="utf-8")
    soak = (ROOT / "frontend/scripts/replay-soak.mjs").read_text(encoding="utf-8")
    rollback = (ROOT / "frontend/scripts/replay-v2-rollback-drill.mjs").read_text(
        encoding="utf-8"
    )
    package = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    verifier = (ROOT / "backend/scripts/verify_replay_v2_release.py").read_text(
        encoding="utf-8"
    )
    for needle in (
        "v2ArchiveLifecycleCycle",
        "v2AccessibilityAudit",
        "v2_keyboard_accessible",
        "v2_reduced_motion_effective",
        "release-4h",
        "--real-klines-source",
        "real_bar_source_profile",
    ):
        assert needle in soak
    for needle in (
        "--live-window",
        "--disable-gap-maintenance",
        '#replay-status-bar, #status-bar[data-runtime-source="replay"]',
        "queryReplayV2Archive",
        "old_build_preserved_replay_db",
        "queryReplayStorageSnapshot",
        "old_build_preserved_storage_semantics",
        'data-replay-launcher="live-modal"',
        "playback-rate",
        "value.clockRate === 60",
    ):
        assert needle in rollback
    assert "--live-window" in smoke
    assert "--disable-gap-maintenance" in smoke
    assert (
        "--duration-ms 14400000 --cycles 100" in package["scripts"]["soak:replay:v2:4h"]
    )
    assert "--product-v2" not in soak
    assert "--product-v2" not in rollback
    assert "--product-v2" not in package["scripts"]["drill:replay:v2:rollback"]
    assert "REPLAY_PRODUCT_V2_ENABLED" not in soak
    assert "REPLAY_PRODUCT_V2_ENABLED" not in rollback
    assert "REPLAY_PRODUCT_V2_ENABLED" not in verifier
    assert "replay-v1-smoke" not in verifier


def test_formal_fast_forward_refreshes_controller_lease_between_chunks() -> None:
    controller_ttl_seconds = 0.5
    result = asyncio.run(
        _run_mode(
            optimized=True,
            trade_count=2_048,
            page_rows=128,
            chunk_events=16,
            tail_events=4,
            event_spacing_ms=1,
            controller_ttl_seconds=controller_ttl_seconds,
        )
    )
    streaming = result["streaming"]
    assert result["result"]["elapsed_seconds"] > controller_ttl_seconds
    assert streaming["chunks"] == 128
    assert streaming["controller_heartbeats"] == 127
