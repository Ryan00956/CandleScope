"""Validate the frozen 22-scenario HEDGE exchange-parity acceptance matrix."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Mapping


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MATRIX_PATH = REPOSITORY_ROOT / "docs" / "replay-hedge-exchange-parity-acceptance.json"
SCHEMA_VERSION = "replay.hedge-exchange-parity.acceptance.v1"
RELEASE_GATES = {
    "backend_full",
    "frontend_full",
    "browser_soak",
    "fresh_boot",
    "static_audit",
}


def validate_matrix(path: Path = MATRIX_PATH) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("HEDGE acceptance matrix must be an object")
    scenarios = payload.get("scenarios")
    contract = payload.get("execution_contract")
    gates = payload.get("release_gates")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("HEDGE acceptance matrix schema drifted")
    if payload.get("expected_scenarios") != 22 or not isinstance(scenarios, list):
        raise ValueError("HEDGE acceptance matrix must contain 22 scenarios")
    if [item.get("id") for item in scenarios if isinstance(item, Mapping)] != list(
        range(1, 23)
    ):
        raise ValueError("HEDGE acceptance scenario ids must be exactly 1..22")
    if set(gates) != RELEASE_GATES if isinstance(gates, list) else True:
        raise ValueError("HEDGE acceptance release gate registry drifted")
    if not isinstance(contract, Mapping) or contract != {
        "real_service": True,
        "sqlite": True,
        "decimal": True,
        "fixture_only_is_sufficient": False,
        "fallback_allowed": False,
    }:
        raise ValueError("HEDGE acceptance execution contract was relaxed")

    validated: list[dict[str, object]] = []
    for scenario in scenarios:
        if not isinstance(scenario, Mapping):
            raise ValueError("HEDGE acceptance scenario must be an object")
        scenario_id = scenario.get("id")
        evidence = scenario.get("evidence")
        scenario_gates = scenario.get("release_gates")
        if not isinstance(evidence, list) or not evidence:
            raise ValueError(f"scenario {scenario_id} has no evidence")
        if (
            not isinstance(scenario_gates, list)
            or not scenario_gates
            or not set(scenario_gates).issubset(RELEASE_GATES)
        ):
            raise ValueError(f"scenario {scenario_id} has malformed release gates")
        paths: list[str] = []
        for item in evidence:
            if not isinstance(item, Mapping):
                raise ValueError(f"scenario {scenario_id} evidence is malformed")
            relative = item.get("path")
            needle = item.get("needle")
            if not isinstance(relative, str) or not isinstance(needle, str) or not needle:
                raise ValueError(f"scenario {scenario_id} evidence is incomplete")
            source = (REPOSITORY_ROOT / relative).resolve()
            try:
                source.relative_to(REPOSITORY_ROOT.resolve())
            except ValueError as exc:
                raise ValueError(f"scenario {scenario_id} escapes repository") from exc
            if not source.is_file() or needle not in source.read_text(encoding="utf-8"):
                raise ValueError(
                    f"scenario {scenario_id} evidence is missing: {relative} :: {needle}"
                )
            paths.append(relative)
        if scenario_id in {*range(1, 20), 21} and not any(
            value.startswith("backend/tests/") for value in paths
        ):
            raise ValueError(f"scenario {scenario_id} lacks a backend real-service test")
        if scenario_id == 22 and "browser_soak" not in scenario_gates:
            raise ValueError("scenario 22 must be bound to the browser soak gate")
        validated.append(
            {
                "id": scenario_id,
                "title": scenario.get("title"),
                "release_gates": scenario_gates,
                "evidence_count": len(evidence),
                "validated": True,
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "passed": True,
        "scenario_count": len(validated),
        "scenarios": validated,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=MATRIX_PATH)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = validate_matrix(args.matrix.resolve())
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out is None:
        print(rendered, end="")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
        print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
