from __future__ import annotations

import json
from pathlib import Path

import pytest

from pyne_runtime.cli import main


def test_cli_schema_prints_public_schema(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["schema"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert exit_code == 0
    assert payload["input"]["schemaVersion"] == 1
    assert payload["output"]["schemaVersion"] == 1


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


def test_cli_version_prints_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["--version"])

    captured = capsys.readouterr()
    assert exc.value.code == 0
    assert captured.out.startswith("pyne ")
