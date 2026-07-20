from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from scripts import audit_replay_determinism, benchmark_replay


BACKEND_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "replay"
GIT_HEAD = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
RECORDED_AT = "2026-07-20T12:34:56Z"


def _completed(
    command: list[str],
    *,
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        command,
        returncode,
        stdout=stdout,
        stderr=stderr,
    )


@pytest.mark.parametrize(
    "module",
    [benchmark_replay, audit_replay_determinism],
    ids=["benchmark", "determinism"],
)
def test_release_git_evidence_binds_clean_head(
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
) -> None:
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        assert kwargs["cwd"] == BACKEND_ROOT.parent
        if command[1] == "rev-parse":
            return _completed(command, stdout=f"{GIT_HEAD}\n")
        return _completed(command)

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    assert module._release_git_evidence() == {
        "git_head": GIT_HEAD.lower(),
        "git_dirty": False,
    }
    assert calls == [
        ["git", "rev-parse", "--verify", "HEAD^{commit}"],
        [
            "git",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
        ["git", "rev-parse", "--verify", "HEAD^{commit}"],
    ]


@pytest.mark.parametrize(
    "module",
    [benchmark_replay, audit_replay_determinism],
    ids=["benchmark", "determinism"],
)
def test_release_git_evidence_rejects_dirty_tree(
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
) -> None:
    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if command[1] == "rev-parse":
            return _completed(command, stdout=f"{GIT_HEAD}\n")
        return _completed(command, stdout=" M backend/app/replay/actor.py\n")

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match="clean Git working tree"):
        module._release_git_evidence()


@pytest.mark.parametrize(
    "module",
    [benchmark_replay, audit_replay_determinism],
    ids=["benchmark", "determinism"],
)
def test_release_git_evidence_rejects_non_git_directory(
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
) -> None:
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda command, **_kwargs: _completed(
            command,
            returncode=128,
            stderr="fatal: not a git repository",
        ),
    )

    with pytest.raises(RuntimeError, match="valid Git HEAD commit"):
        module._release_git_evidence()


@pytest.mark.parametrize(
    "module",
    [benchmark_replay, audit_replay_determinism],
    ids=["benchmark", "determinism"],
)
def test_release_git_evidence_rejects_head_drift(
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
) -> None:
    head_reads = 0

    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        nonlocal head_reads
        if command[1] == "status":
            return _completed(command)
        head_reads += 1
        head = GIT_HEAD if head_reads == 1 else "a" * 40
        return _completed(command, stdout=f"{head}\n")

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match="HEAD changed"):
        module._release_git_evidence()


@pytest.mark.parametrize(
    "module",
    [benchmark_replay, audit_replay_determinism],
    ids=["benchmark", "determinism"],
)
def test_recorded_at_is_current_utc(module: ModuleType) -> None:
    recorded_at = module._utc_recorded_at()
    assert recorded_at.endswith("Z")
    parsed = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
    assert parsed.tzinfo == timezone.utc
    assert abs((datetime.now(timezone.utc) - parsed).total_seconds()) < 5


def _benchmark_section(*, trade: bool) -> dict[str, object]:
    bounds: dict[str, object] = {"retained_structures_bounded": True}
    if trade:
        bounds.update(
            archive_max_page_rows=50,
            full_history_materialized=False,
        )
    return {
        "result": {"events_per_second": 100},
        "memory": {"peak_delta_bytes": 0, "late_half_growth_bytes": 0},
        "projection": {"max_fps": 30, "capacity_forced_flushes": 0},
        "bounds": bounds,
    }


def _benchmark_args(*, baseline: Path | None) -> argparse.Namespace:
    return argparse.Namespace(
        baseline=baseline,
        skip_bar=False,
        skip_trade=False,
        bars=1,
        trades=1,
        trade_page_rows=50,
        max_closed_bars=1,
        command_queue_size=1,
        event_buffer_size=1,
        checkpoint_event_interval=1,
        checkpoint_virtual_ms=1,
    )


def test_release_benchmark_emits_bound_git_and_dynamic_utc_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_order: list[str] = []

    def release_evidence() -> dict[str, object]:
        call_order.append("git")
        return {"git_head": GIT_HEAD.lower(), "git_dirty": False}

    async def bar_benchmark(**_kwargs: Any) -> dict[str, object]:
        call_order.append("bar")
        return _benchmark_section(trade=False)

    async def trade_benchmark(**_kwargs: Any) -> dict[str, object]:
        call_order.append("trade")
        return _benchmark_section(trade=True)

    monkeypatch.setattr(benchmark_replay, "_release_git_evidence", release_evidence)
    monkeypatch.setattr(benchmark_replay, "_utc_recorded_at", lambda: RECORDED_AT)
    monkeypatch.setattr(benchmark_replay, "run_bar_benchmark", bar_benchmark)
    monkeypatch.setattr(benchmark_replay, "run_actor_benchmark", trade_benchmark)
    monkeypatch.setattr(
        benchmark_replay,
        "_load_thresholds",
        lambda _path: {
            "bar_min_events_per_second": 1,
            "bar_max_peak_delta_bytes": 1,
            "bar_max_late_half_growth_bytes": 1,
            "trade_min_events_per_second": 1,
            "trade_max_peak_delta_bytes": 1,
            "trade_max_late_half_growth_bytes": 1,
            "projection_max_fps": 30,
            "trade_max_page_rows": 50,
        },
    )

    report = asyncio.run(
        benchmark_replay.run_suite(_benchmark_args(baseline=Path("baseline.json")))
    )

    assert call_order == ["git", "bar", "trade"]
    assert report["recorded_at"] == RECORDED_AT
    assert report["git_head"] == GIT_HEAD.lower()
    assert report["git_dirty"] is False
    assert report["environment"]["git_head"] == GIT_HEAD.lower()
    assert report["acceptance"]["passed"] is True


def test_determinism_parent_emits_bound_git_and_dynamic_utc_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        audit_replay_determinism,
        "_release_git_evidence",
        lambda: {"git_head": GIT_HEAD.lower(), "git_dirty": False},
    )
    monkeypatch.setattr(
        audit_replay_determinism,
        "_utc_recorded_at",
        lambda: RECORDED_AT,
    )
    monkeypatch.setattr(
        audit_replay_determinism,
        "_candidate",
        lambda source, *, repetitions: {
            "source": source,
            "repetitions": repetitions,
        },
    )

    report = audit_replay_determinism._parent_payload(
        argparse.Namespace(
            repetitions=2,
            print_candidates=True,
            golden_dir=FIXTURE_ROOT,
        )
    )

    assert report["recorded_at"] == RECORDED_AT
    assert report["git_head"] == GIT_HEAD.lower()
    assert report["git_dirty"] is False
    assert set(report["candidates"]) == {"bar", "agg_trade"}


def test_determinism_worker_does_not_inspect_git(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run_path(source: str, path: str) -> dict[str, object]:
        return {"source": source, "path": path}

    def fail_git_check() -> dict[str, object]:
        raise AssertionError("worker mode must not inspect Git")

    monkeypatch.setattr(audit_replay_determinism, "_run_path", run_path)
    monkeypatch.setattr(
        audit_replay_determinism,
        "_release_git_evidence",
        fail_git_check,
    )

    assert audit_replay_determinism._worker_payload(
        argparse.Namespace(
            worker_source="bar",
            worker_path="step",
            checkpoint_in=None,
        )
    ) == {"source": "bar", "path": "step"}


@pytest.mark.parametrize(
    ("filename", "source_kind"),
    [
        ("golden_bar_session_v1.json", "bar"),
        ("golden_agg_trade_session_v1.json", "agg_trade"),
    ],
)
def test_golden_session_freezes_config_command_log_and_final_hashes(
    filename: str,
    source_kind: str,
) -> None:
    payload = json.loads((FIXTURE_ROOT / filename).read_text(encoding="utf-8"))

    assert payload["schema_version"] == "replay-golden-session.v1"
    assert payload["source_kind"] == source_kind
    assert payload["config"]["source_kind"] == source_kind
    assert payload["command_log"]["common_prefix"]
    assert set(payload["command_log"]["paths"]) == {
        "step",
        "advance",
        "max",
        "speed_step",
        "pause_step",
        "checkpoint",
        "restart",
    }
    assert payload["final"]["state"] == "ENDED"
    assert payload["final"]["actor_state_hash"].startswith("sha256:")
    assert payload["final"]["report_hash"].startswith("sha256:")
    assert payload["ledger_audit"]["zero_difference"] is True
    assert payload["equivalence"]["all_equal"] is True


def test_cross_process_determinism_auditor_accepts_both_golden_sessions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        audit_replay_determinism,
        "_release_git_evidence",
        lambda: {"git_head": GIT_HEAD.lower(), "git_dirty": False},
    )
    monkeypatch.setattr(
        audit_replay_determinism,
        "_utc_recorded_at",
        lambda: RECORDED_AT,
    )

    report = audit_replay_determinism._parent_payload(
        argparse.Namespace(
            repetitions=2,
            print_candidates=False,
            golden_dir=FIXTURE_ROOT,
        )
    )

    assert report["passed"] is True
    assert report["recorded_at"] == RECORDED_AT
    assert report["git_head"] == GIT_HEAD.lower()
    assert report["git_dirty"] is False
    assert report["sources"]["bar"]["passed"] is True
    assert report["sources"]["agg_trade"]["passed"] is True
