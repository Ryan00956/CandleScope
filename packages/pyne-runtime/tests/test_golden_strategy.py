from __future__ import annotations

import json
from pathlib import Path

import pytest

import pyne_runtime as pn


GOLDEN_DIR = Path(__file__).parent / "golden"


@pytest.mark.parametrize(
    "fixture_name",
    [
        "strategy_pine_equivalent_smoke.json",
        "strategy_pine_equivalent_pending_entries.json",
        "strategy_pine_equivalent_bracket_exit.json",
        "strategy_pine_equivalent_costs.json",
        "strategy_pine_equivalent_cost_allocation.json",
        "strategy_pine_equivalent_reversal_pyramiding.json",
        "strategy_pine_equivalent_oca_risk.json",
        "strategy_pine_equivalent_risk_size_limit.json",
        "strategy_pine_equivalent_exit_path.json",
        "strategy_pine_equivalent_short_paths.json",
        "strategy_pine_equivalent_margin_order_cancel.json",
    ],
)
def test_strategy_pine_equivalent_golden(fixture_name: str) -> None:
    fixture = json.loads((GOLDEN_DIR / fixture_name).read_text())

    for case in fixture["cases"]:
        _assert_strategy_pine_equivalent_case(case)


def _assert_strategy_pine_equivalent_case(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    for title, values in case["values"].items():
        assert result.values(title) == values
    _assert_external_capture(case, result)
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


def _assert_external_capture(case: dict, result: pn.PyneResult) -> None:
    capture = case.get("external_capture")
    if capture is None:
        return

    assert capture["provider"] == "tradingview"
    assert capture["status"] in {"not_captured", "captured"}
    if capture["status"] == "not_captured":
        assert "values" not in capture
        return

    assert capture.get("assertion", "parity") in {"reference", "parity"}
    assert isinstance(capture.get("values"), dict)
    if "bars" in capture:
        assert len(capture["bars"]) == len(next(iter(capture["values"].values())))
    if capture.get("assertion", "parity") == "reference":
        return

    capture_result = result
    if "bars" in capture:
        capture_result = pn.run(case["script"], capture["bars"], executor_mode="inline")
        assert capture_result.ok, capture_result.error

    tolerance = capture.get("tolerance", 0.0)
    for title, expected_values in capture["values"].items():
        actual_values = capture_result.values(title)
        assert len(actual_values) == len(expected_values)
        for actual, expected in zip(actual_values, expected_values, strict=True):
            assert actual == pytest.approx(expected, abs=tolerance)


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_same_bar_priority.json").read_text())["cases"],
    ids=lambda case: case["name"],
)
def test_strategy_same_bar_priority_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert (
        result.output["strategy"]["summary"]["same_bar_fill_priority"]
        == case["same_bar_fill_priority"]
    )
    assert result.output["strategy"]["summary"]["intrabar_path"] == case["intrabar_path"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_lifecycle.json").read_text())["cases"],
    ids=lambda case: case["name"],
)
def test_strategy_lifecycle_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.values("Position") == case["position"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_risk_lock.json").read_text())["cases"],
    ids=lambda case: case["name"],
)
def test_strategy_risk_lock_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_lot_matching.json").read_text())["cases"],
    ids=lambda case: case["name"],
)
def test_strategy_lot_matching_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_intraday_risk_reset.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_intraday_risk_reset_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.values("Position") == case["position"]
    if "equity" in case:
        assert result.values("Equity") == case["equity"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_pending_risk_lock.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_pending_risk_lock_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_oca_lifecycle.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_oca_lifecycle_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.values("Position") == case["position"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_cost_model.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_cost_model_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    if "closed_commission" in case:
        assert result.values("Closed Commission") == case["closed_commission"]
    if "first_closed_commission" in case:
        assert (
            result.values("First Closed Commission")
            == case["first_closed_commission"]
        )
    if "last_closed_commission" in case:
        assert (
            result.values("Last Closed Commission")
            == case["last_closed_commission"]
        )
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_limit_verification_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_limit_verification_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    if "closed_commission" in case:
        assert result.values("Closed Commission") == case["closed_commission"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_bracket_stop_limit_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_bracket_stop_limit_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    assert result.values("Closed Commission") == case["closed_commission"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_risk_margin_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_risk_margin_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    assert result.values("Closed Commission") == case["closed_commission"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_entry_size_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_entry_size_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    if "first_closed_commission" in case:
        assert (
            result.values("First Closed Commission")
            == case["first_closed_commission"]
        )
    if "last_closed_commission" in case:
        assert (
            result.values("Last Closed Commission")
            == case["last_closed_commission"]
        )
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_reversal_lot_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_reversal_lot_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    assert (
        result.values("First Closed Commission")
        == case["first_closed_commission"]
    )
    assert result.values("Last Closed Commission") == case["last_closed_commission"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_oca_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_oca_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    if "closed_commission" in case:
        assert result.values("Closed Commission") == case["closed_commission"]
    if "first_closed_commission" in case:
        assert (
            result.values("First Closed Commission")
            == case["first_closed_commission"]
        )
    if "last_closed_commission" in case:
        assert result.values("Last Closed Commission") == case["last_closed_commission"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_pending_risk_recovery_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_pending_risk_recovery_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    assert result.values("Closed Commission") == case["closed_commission"]
    if "first_open_size" in case:
        assert result.values("First Open Size") == case["first_open_size"]
    if "second_open_size" in case:
        assert result.values("Second Open Size") == case["second_open_size"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_cancel_risk_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_cancel_risk_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    assert result.values("Position") == case["position"]
    assert result.values("Equity") == case["equity"]
    assert result.values("Net Profit") == case["netprofit"]
    if "open_commission" in case:
        assert result.values("Open Commission") == case["open_commission"]
    if "closed_commission" in case:
        assert result.values("Closed Commission") == case["closed_commission"]
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_trade_accessors.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_trade_accessors_golden(case: dict) -> None:
    result = pn.run(
        case["script"],
        case["bars"],
        settings=pn.PyneSettings(executor_mode="inline", max_output_series=30),
    )

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    for title, values in case["values"].items():
        assert result.values(title) == values
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]


@pytest.mark.parametrize(
    "case",
    json.loads((GOLDEN_DIR / "strategy_mixed_lifecycle_costs.json").read_text())[
        "cases"
    ],
    ids=lambda case: case["name"],
)
def test_strategy_mixed_lifecycle_costs_golden(case: dict) -> None:
    result = pn.run(case["script"], case["bars"], executor_mode="inline")

    assert result.ok, result.error
    assert result.output["strategy"]["orders"] == case["orders"]
    assert result.output["strategy"]["lifecycle"] == case["lifecycle"]
    assert result.output["strategy"]["closedtrades"] == case["closedtrades"]
    assert result.output["strategy"]["opentrades"] == case["opentrades"]
    for title, values in case["values"].items():
        assert result.values(title) == values
    assert result.output["strategy"]["summary"] == case["summary"]
    assert result.output["strategy"]["risk"] == case["risk"]
