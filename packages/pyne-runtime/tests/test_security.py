from __future__ import annotations

import pytest

import pyne_runtime as pn
from pyne_runtime import PyneSettings
from pyne_runtime.security import PyneSecurityPolicy, validate_script_security


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 1.5, "high": 2.5, "low": 1.4, "close": 2.0, "volume": 120},
    ]


def test_safe_mode_blocks_imports() -> None:
    result = pn.run("import os\nplot(close)", _bars(), executor_mode="inline")

    assert not result.ok
    assert result.code == "PYNE_IMPORT_BLOCKED"
    assert result.error_detail["code"] == "PYNE_IMPORT_BLOCKED"
    assert "docsUrl" in result.error_detail


def test_research_mode_allows_whitelisted_imports() -> None:
    settings = PyneSettings(security_mode="research", allowed_imports=("math",))

    result = pn.run(
        "import math\nplot([math.sqrt(x) for x in close])",
        _bars(),
        settings=settings,
        executor_mode="inline",
    )

    assert result.ok


def test_research_mode_blocks_unlisted_imports() -> None:
    settings = PyneSettings(security_mode="research", allowed_imports=("math",))

    result = pn.run("import os\nplot(close)", _bars(), settings=settings, executor_mode="inline")

    assert not result.ok
    assert result.code == "PYNE_IMPORT_BLOCKED"


def test_output_limits_count_barcolor_points() -> None:
    settings = PyneSettings(max_output_points=2)

    result = pn.run(
        """
barcolor(color.green)
""",
        [
            {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1, "volume": 100},
            {"time": 2, "open": 1, "high": 2, "low": 1, "close": 1, "volume": 100},
            {"time": 3, "open": 1, "high": 2, "low": 1, "close": 1, "volume": 100},
        ],
        settings=settings,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_OUTPUT_LIMIT_EXCEEDED"


def test_validate_script_security_propagates_syntax_errors() -> None:
    with pytest.raises(SyntaxError):
        validate_script_security("if", PyneSecurityPolicy.from_settings(PyneSettings()))
