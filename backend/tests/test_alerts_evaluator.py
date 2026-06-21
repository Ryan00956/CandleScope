from __future__ import annotations

from app.alerts.evaluator import AlertEvaluator


def test_alert_evaluator_supports_nested_boolean_logic() -> None:
    evaluator = AlertEvaluator()
    expression = {
        "op": "AND",
        "children": [
            {
                "left": "close",
                "comparator": "crossesAbove",
                "right": {"type": "number", "value": 100},
            },
            {
                "op": "OR",
                "children": [
                    {"left": "rsi", "comparator": ">", "right": {"type": "number", "value": 70}},
                    {"left": "macdHist", "comparator": "crossesAbove", "right": {"type": "number", "value": 0}},
                ],
            },
            {
                "op": "NOT",
                "children": [
                    {"left": "volume", "comparator": "<", "right": {"type": "number", "value": 10}},
                ],
            },
        ],
    }

    result = evaluator.evaluate(expression, {
        "previous": {"close": 99, "rsi": 65, "macdHist": -0.1, "volume": 20},
        "values": {"close": 101, "rsi": 66, "macdHist": 0.2, "volume": 20},
    })

    assert result is True


def test_alert_evaluator_supports_field_to_field_comparison() -> None:
    evaluator = AlertEvaluator()

    assert evaluator.evaluate(
        {"left": "close", "comparator": ">", "right": {"type": "field", "value": "ma20"}},
        {"values": {"close": 105, "ma20": 100}},
    ) is True


def test_alert_evaluator_trace_explains_nested_result() -> None:
    evaluator = AlertEvaluator()
    result = evaluator.evaluate_with_trace(
        {
            "op": "AND",
            "children": [
                {"left": "close", "comparator": "crossesAbove", "right": {"type": "number", "value": 100}},
                {"left": "rsi", "comparator": ">", "right": {"type": "number", "value": 70}},
            ],
        },
        {
            "previous": {"close": 99, "rsi": 69},
            "values": {"close": 101, "rsi": 72},
        },
    )

    assert result["result"] is True
    assert result["trace"]["op"] == "AND"
    assert [child["status"] for child in result["trace"]["children"]] == ["matched", "matched"]


def test_alert_evaluator_trace_marks_missing_previous_values() -> None:
    evaluator = AlertEvaluator()
    result = evaluator.evaluate_with_trace(
        {"left": "close", "comparator": "crossesAbove", "right": {"type": "number", "value": 100}},
        {"values": {"close": 101}},
    )

    assert result["result"] is False
    assert result["trace"]["status"] == "missing_previous"


def test_alert_evaluator_supports_range_comparators() -> None:
    evaluator = AlertEvaluator()

    assert evaluator.evaluate(
        {"left": "rsi", "comparator": "between", "right": {"type": "range", "min": 30, "max": 70}},
        {"values": {"rsi": 55}},
    ) is True
    assert evaluator.evaluate(
        {"left": "rsi", "comparator": "outsideRange", "right": {"type": "range", "min": 30, "max": 70}},
        {"values": {"rsi": 82}},
    ) is True


def test_alert_evaluator_supports_percent_change_comparators() -> None:
    evaluator = AlertEvaluator()

    assert evaluator.evaluate(
        {"left": "close", "comparator": "percentChangeAbove", "right": {"type": "percent", "value": 2}},
        {"previous": {"close": 100}, "values": {"close": 103}},
    ) is True
    assert evaluator.evaluate(
        {"left": "close", "comparator": "percentChangeBelow", "right": {"type": "percent", "value": -2}},
        {"previous": {"close": 100}, "values": {"close": 97}},
    ) is True


def test_alert_evaluator_trace_includes_range_and_percent_details() -> None:
    evaluator = AlertEvaluator()
    range_result = evaluator.evaluate_with_trace(
        {"left": "rsi", "comparator": "between", "right": {"type": "range", "min": 30, "max": 70}},
        {"values": {"rsi": 55}},
    )
    percent_result = evaluator.evaluate_with_trace(
        {"left": "close", "comparator": "percentChangeAbove", "right": {"type": "percent", "value": 2}},
        {"previous": {"close": 100}, "values": {"close": 103}},
    )

    assert range_result["trace"]["details"]["rangeMin"] == 30
    assert range_result["trace"]["details"]["rangeMax"] == 70
    assert percent_result["trace"]["details"]["percentChange"] == 3
