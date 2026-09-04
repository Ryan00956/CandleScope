from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from app.backtest.python_bundle_rollback import rollback_python_bundles
from app.backtest.schema import SCHEMA_VERSION, apply_schema
from app.backtest.service import BacktestService
from app.backtest.strategy.protocol import StrategyProviderError
from app.backtest.strategy.python_bundle import inspect_directory, inspect_zip
from app.core.config import load_backtest_settings

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-backtest-sdk"
    / "fixtures"
    / "sma_cross"
)


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _zip_fixture() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name in ("strategy.json", "strategy.py", "requirements.lock"):
            archive.writestr(name, (FIXTURE / name).read_bytes())
    return buffer.getvalue()


def test_directory_and_zip_share_canonical_bundle_hash() -> None:
    directory = inspect_directory(FIXTURE)
    zipped = inspect_zip(_zip_fixture())
    assert directory["bundle_hash"] == zipped["bundle_hash"]
    assert directory["manifest_hash"] == zipped["manifest_hash"]


def test_mutating_source_changes_revision_identity(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    first = service.create_python_strategy_bundle(directory=str(FIXTURE), now_ms=2)
    first_revision = service.create_python_strategy_revision(
        first["bundle_id"], now_ms=3
    )
    mutated = tmp_path / "mutated"
    mutated.mkdir()
    for name in ("strategy.json", "strategy.py", "requirements.lock"):
        mutated.joinpath(name).write_bytes((FIXTURE / name).read_bytes())
    mutated.joinpath("strategy.py").write_text(
        FIXTURE.joinpath("strategy.py").read_text(encoding="utf-8") + "\n# changed\n",
        encoding="utf-8",
        newline="\n",
    )
    second = service.create_python_strategy_bundle(directory=str(mutated), now_ms=4)
    assert second["bundle_hash"] != first["bundle_hash"]
    second_revision = service.create_python_strategy_revision(
        second["bundle_id"], now_ms=5
    )
    assert second_revision["revision_id"] != first_revision["revision_id"]
    assert first["bundle_hash"] == service.get_python_strategy_bundle(first["bundle_id"])[
        "bundle_hash"
    ]


def test_rejects_zip_slip_and_oversize() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("../secret.py", b"print(1)\n")
    with pytest.raises(StrategyProviderError, match="BUNDLE_PATH_INVALID"):
        inspect_zip(buffer.getvalue())


def test_freeze_is_independent_of_user_directory(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    working = tmp_path / "user"
    working.mkdir()
    for name in ("strategy.json", "strategy.py", "requirements.lock"):
        working.joinpath(name).write_bytes((FIXTURE / name).read_bytes())
    created = service.create_python_strategy_bundle(directory=str(working), now_ms=2)
    working.joinpath("strategy.py").write_text("# overwritten\n", encoding="utf-8")
    stored = inspect_directory(
        Path(service.repository.get_strategy_bundle(created["bundle_id"])["store_path"])
    )
    assert stored["bundle_hash"] == created["bundle_hash"]


def test_python_bundle_api_is_default_off(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1.backtests import _python_strategy_enabled, _require_python_strategy
    from app.backtest.errors import BacktestError

    monkeypatch.setenv("BACKTEST_PYTHON_STRATEGY_ENABLED", "0")
    assert _python_strategy_enabled() is False
    with pytest.raises(BacktestError, match="default-off"):
        _require_python_strategy()


def test_schema_rollback_fails_closed_with_data_and_succeeds_when_empty(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    assert SCHEMA_VERSION == 7
    service.create_python_strategy_bundle(directory=str(FIXTURE), now_ms=2)
    with pytest.raises(RuntimeError, match="fail-closed"):
        rollback_python_bundles(service.settings.db_path)
    empty = tmp_path / "empty.db"
    connection = __import__("sqlite3").connect(empty)
    apply_schema(connection, now_ms=1)
    connection.commit()
    connection.close()
    result = rollback_python_bundles(empty)
    assert result["schemaVersion"] == 5
