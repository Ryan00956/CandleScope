"""Budgeted, deterministic Study planning. No live search, no IS leakage into OOS rank."""

from __future__ import annotations

import itertools
import json
import random
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

from app.backtest.errors import BacktestError
from app.backtest.identity import sha256_hex


@dataclass(frozen=True, slots=True)
class Split:
    split_id: str
    role: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True, slots=True)
class TrialSpec:
    ordinal: int
    split_id: str
    params: dict[str, Any]
    params_hash: str


def walk_forward_splits(
    *,
    start_ms: int,
    end_ms: int,
    train_ms: int,
    test_ms: int,
    step_ms: int,
) -> tuple[Split, ...]:
    if train_ms <= 0 or test_ms <= 0 or step_ms <= 0:
        raise BacktestError("STUDY_SPLIT_LEAK", "walk-forward windows must be positive")
    splits: list[Split] = []
    cursor = start_ms
    index = 1
    while cursor + train_ms + test_ms <= end_ms:
        train_start = cursor
        train_end = cursor + train_ms
        test_start = train_end
        test_end = train_end + test_ms
        splits.append(Split(f"wf-{index}-train", "train", train_start, train_end))
        splits.append(Split(f"wf-{index}-test", "test", test_start, test_end))
        cursor += step_ms
        index += 1
    if not splits:
        raise BacktestError("STUDY_SPLIT_LEAK", "walk-forward produced no windows")
    assert_no_leakage(splits)
    return tuple(splits)


def assert_no_leakage(splits: Sequence[Split]) -> None:
    tests = [item for item in splits if item.role == "test"]
    trains = [item for item in splits if item.role == "train"]
    for test in tests:
        if test.end_ms <= test.start_ms:
            raise BacktestError("STUDY_SPLIT_LEAK", "empty test window")
        for train in trains:
            if train.split_id.split("-")[:2] != test.split_id.split("-")[:2]:
                continue
            if test.start_ms < train.end_ms:
                raise BacktestError("STUDY_SPLIT_LEAK", "test window overlaps its train window")


def grid_sampler(space: Mapping[str, Sequence[Any]]) -> tuple[dict[str, Any], ...]:
    keys = tuple(sorted(space))
    values = [tuple(space[key]) for key in keys]
    rows = []
    for combo in itertools.product(*values):
        rows.append({key: value for key, value in zip(keys, combo, strict=True)})
    return tuple(rows)


def random_sampler(
    space: Mapping[str, Sequence[Any]],
    *,
    count: int,
    seed: int,
) -> tuple[dict[str, Any], ...]:
    rng = random.Random(seed)
    keys = tuple(sorted(space))
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    attempts = 0
    while len(rows) < count and attempts < count * 32:
        attempts += 1
        item = {key: rng.choice(tuple(space[key])) for key in keys}
        digest = sha256_hex(item)
        if digest in seen:
            continue
        seen.add(digest)
        rows.append(item)
    return tuple(rows)


def plan_trials(
    splits: Sequence[Split],
    params: Sequence[Mapping[str, Any]],
    *,
    max_trials: int,
) -> tuple[TrialSpec, ...]:
    if max_trials < 1:
        raise BacktestError("BUDGET_EXCEEDED", "max_trials must be at least 1")
    tests = [item for item in splits if item.role == "test"]
    planned: list[TrialSpec] = []
    ordinal = 1
    for split in tests:
        for param in params:
            if len(planned) >= max_trials:
                return tuple(planned)
            frozen = dict(param)
            planned.append(
                TrialSpec(
                    ordinal=ordinal,
                    split_id=split.split_id,
                    params=frozen,
                    params_hash="sha256:" + sha256_hex(frozen),
                )
            )
            ordinal += 1
    return tuple(planned)


def comparable_identity(run: Mapping[str, Any]) -> tuple[str, ...]:
    try:
        config = json.loads(str(run.get("config_json") or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        config = {}
    return (
        str(run.get("fidelity_mode") or ""),
        str(run.get("source_event_kind") or ""),
        str(run.get("dataset_id") or ""),
        str(run.get("data_epoch") or ""),
        str(run.get("engine_version") or ""),
        str(run.get("strategy_revision_id") or ""),
        str(config.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"),
        str(config.get("initial_balance") or "10000"),
        str(config.get("slippage_bps") or "1"),
        str(config.get("taker_fee_bps") or "0"),
        str(config.get("gap_policy") or "REJECT"),
        str(config.get("interval") or ""),
    )


def compare_runs(runs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not runs:
        raise BacktestError("SCHEMA_UNKNOWN_FIELD", "no runs to compare")
    identities = {comparable_identity(run) for run in runs}
    if len(identities) != 1:
        raise BacktestError("STUDY_SPLIT_LEAK", "incompatible runs cannot be compared")
    return {
        "ok": True,
        "count": len(runs),
        "identity": list(identities.pop()),
    }


def rank_oos(
    trials: Sequence[Mapping[str, Any]],
    *,
    objective: str = "oos_score",
) -> list[dict[str, Any]]:
    ranked = sorted(
        trials,
        key=lambda item: float(item.get(objective) or 0),
        reverse=True,
    )
    return [
        {
            "ordinal": item.get("ordinal"),
            "split_id": item.get("split_id"),
            "params": item.get("params"),
            "oos_score": item.get(objective),
            "in_sample_score": item.get("in_sample_score"),
            "selection_warning": "in-sample best is not an OOS claim",
        }
        for item in ranked
    ]


def trial_wire(spec: TrialSpec) -> dict[str, Any]:
    return asdict(spec)


def split_wire(split: Split) -> dict[str, Any]:
    return asdict(split)
