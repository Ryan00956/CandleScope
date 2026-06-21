from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from pyne_runtime import PYNE_REQUEST_PROVIDER_SCHEMA_VERSION
from pyne_runtime.cli import main


def test_cli_schema_prints_public_schema(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["schema"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert exit_code == 0
    assert payload["input"]["schemaVersion"] == 1
    assert payload["output"]["schemaVersion"] == 1
    assert payload["params"]["schemaVersion"] == 1
    assert payload["requestProvider"]["schemaVersion"] == PYNE_REQUEST_PROVIDER_SCHEMA_VERSION
    assert [item["api"] for item in payload["requestProvider"]["supportedApis"]] == [
        "request.security",
        "request.security_lower_tf",
    ]
    assert payload["requestProvider"]["cache"]["scope"] == "one script run"
    assert payload["requestProvider"]["errors"]["capabilityFailure"] == "PYNE_RUNTIME_ERROR"
    assert (
        payload["requestProvider"]["errorCategories"]["invalidSymbol"]["code"]
        == "PYNE_INVALID_SYMBOL"
    )


def test_cli_validate_reports_syntax_error(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    script = tmp_path / "broken.py"
    script.write_text("plot(close,\n", encoding="utf-8")

    exit_code = main(["validate", str(script)])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert exit_code == 1
    assert payload["ok"] is False
    assert payload["diagnostics"][0]["code"] == "PYNE_SYNTAX_ERROR"


def test_cli_validate_reports_migration_hint(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    script = tmp_path / "series_if.py"
    script.write_text(
        """
if close > open:
    plot(close, "Up Close")
""",
        encoding="utf-8",
    )

    exit_code = main(["validate", str(script)])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert exit_code == 1
    assert payload["ok"] is False
    assert payload["diagnostics"][0]["code"] == "PYNE_MIGRATION_HINT"


def test_cli_version_prints_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["--version"])

    captured = capsys.readouterr()
    assert exc.value.code == 0
    assert captured.out.startswith("pyne ")


def test_module_entrypoint_prints_version() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "pyne_runtime", "--version"],
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.startswith("pyne ")
