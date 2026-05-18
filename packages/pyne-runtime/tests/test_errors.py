from __future__ import annotations

import pyne_runtime as pn
from pyne_runtime.errors import ERROR_DOCS, ERROR_HINTS, classify_security_error, error_detail


def test_error_registry_has_docs_for_each_hint() -> None:
    assert set(ERROR_HINTS) == set(ERROR_DOCS)
    assert "PYNE_IMPORT_BLOCKED" in ERROR_HINTS


def test_error_detail_adds_hint_and_docs_url() -> None:
    detail = error_detail("PYNE_IMPORT_BLOCKED", "Import 'os' is not allowed")

    assert detail["code"] == "PYNE_IMPORT_BLOCKED"
    assert "Safe mode blocks imports" in detail["hint"]
    assert detail["docsUrl"].endswith("#pyne-import-blocked")


def test_security_error_classification() -> None:
    assert classify_security_error("Import 'os' is not allowed") == "PYNE_IMPORT_BLOCKED"
    assert classify_security_error("Too many output points") == "PYNE_OUTPUT_LIMIT_EXCEEDED"
    assert classify_security_error("Nope") == "PYNE_SECURITY_ERROR"


def test_runtime_error_detail_includes_docs_url() -> None:
    result = pn.run("import os\nplot(close)", [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
    ], executor_mode="inline")

    assert not result.ok
    assert result.error_detail["code"] == "PYNE_IMPORT_BLOCKED"
    assert result.error_detail["docsUrl"].endswith("#pyne-import-blocked")

