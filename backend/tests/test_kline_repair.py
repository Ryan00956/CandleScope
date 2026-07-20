from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.data_engine.backfill.models import (
    BackfillStatus,
    FetchResult,
    FetchedBar,
)
from app.data_engine.storage.kline_repair import (
    KlineRepairRunner,
    REPAIR_SOURCE,
    RepairApplyError,
    RepairRequest,
    RepairValidationError,
    _repair_fetch_bar_budget,
)
from scripts import repair_binance_klines as repair_cli


NOW = datetime(2026, 7, 20, 12, 0, tzinfo=timezone.utc)
OPEN_1 = 1_752_123_600_000
OPEN_2 = OPEN_1 + 3_600_000
ENHANCED = frozenset(
    {"quote_volume", "trades", "taker_buy_base", "taker_buy_quote"}
)
OFFICIAL_ENDPOINTS = {
    "spot": ("https://api.binance.com",),
    "futures": ("https://fapi.binance.com",),
}


class FakeFetcher:
    def __init__(
        self,
        bars: list[FetchedBar],
        *,
        fail: bool = False,
        raise_error: bool = False,
    ) -> None:
        self.bars = bars
        self.fail = fail
        self.raise_error = raise_error
        self.tasks = []

    async def fetch(self, tasks):
        self.tasks.extend(tasks)
        if self.raise_error:
            raise RuntimeError("provider unavailable")
        results = []
        for task in tasks:
            matching = [
                bar
                for bar in self.bars
                if bar.exchange == task.exchange
                and bar.market_type == task.market_type
                and bar.symbol == task.symbol
                and bar.interval == task.interval
                and task.start_ms <= bar.open_time <= task.end_ms
            ]
            results.append(
                FetchResult(
                    task=task,
                    bars=matching,
                    status=BackfillStatus.FAILED if self.fail else BackfillStatus.COMPLETED,
                    errors=["HTTP 503"] if self.fail else [],
                )
            )
        return results


def _runner(fetcher, **kwargs) -> KlineRepairRunner:
    return KlineRepairRunner(
        fetcher,
        official_endpoints=OFFICIAL_ENDPOINTS,
        **kwargs,
    )


def _create_db(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE klines (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time INTEGER NOT NULL,
                close_time INTEGER,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                quote_volume REAL,
                trades INTEGER,
                taker_buy_base REAL,
                taker_buy_quote REAL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (exchange, market_type, symbol, interval, open_time)
            );
            CREATE TABLE unrelated_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO unrelated_state VALUES ('sentinel', 'preserve-me');
            """
        )


def _local_row(
    open_time: int,
    close: float = 105.0,
    *,
    exchange: str = "binance",
    market_type: str = "spot",
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    source: str = "data_manager_closed",
) -> dict:
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        "open_time": open_time,
        "close_time": open_time + 3_599_999,
        "open": 100.0,
        "high": 110.0,
        "low": 90.0,
        "close": close,
        "volume": 12.5,
        "quote_volume": 1_250.0,
        "trades": 42,
        "taker_buy_base": 6.0,
        "taker_buy_quote": 600.0,
        "source": source,
        "created_at": 111,
        "updated_at": 222,
    }


def _insert(path: Path, row: dict) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            INSERT INTO klines (
                exchange, market_type, symbol, interval, open_time, close_time,
                open, high, low, close, volume, quote_volume, trades,
                taker_buy_base, taker_buy_quote, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            tuple(row[key] for key in row),
        )


def _official(row: dict, *, close: float | None = None) -> FetchedBar:
    return FetchedBar(
        symbol=row["symbol"],
        interval=row["interval"],
        open_time=row["open_time"],
        close_time=row["close_time"],
        open=row["open"],
        high=row["high"],
        low=row["low"],
        close=row["close"] if close is None else close,
        volume=row["volume"],
        exchange=row["exchange"],
        market_type=row["market_type"],
        quote_volume=row["quote_volume"],
        trades=row["trades"],
        taker_buy_base=row["taker_buy_base"],
        taker_buy_quote=row["taker_buy_quote"],
        enhanced_fields=ENHANCED,
    )


def _read_row(path: Path, open_time: int = OPEN_1) -> sqlite3.Row:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM klines WHERE open_time=?", (open_time,)).fetchone()
        assert row is not None
        return row
    finally:
        conn.close()


def _request(path: Path, *, apply: bool = False, **kwargs) -> RepairRequest:
    return RepairRequest(
        db_path=path,
        report_path=path.with_name("repair-report.json"),
        apply=apply,
        confirm=apply,
        **kwargs,
    )


def _run(runner: KlineRepairRunner, request: RepairRequest) -> dict:
    return asyncio.run(runner.run(request))


def test_dry_run_is_database_read_only_and_plans_exact_relabel(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)
    before = db.read_bytes()

    manifest = _run(
        _runner(FakeFetcher([_official(local)]), now=lambda: NOW),
        _request(db),
    )

    assert db.read_bytes() == before
    assert _read_row(db)["source"] == "data_manager_closed"
    assert manifest["result"] == {"status": "dry_run_ready", "applied": 0}
    assert manifest["counts"]["exact_relabel"] == 1
    assert manifest["counts"]["mismatch_replace"] == 0
    assert not list(tmp_path.glob("*.bak"))
    assert json.loads((tmp_path / "repair-report.json").read_text("utf-8"))["counts"]["planned"] == 1


def test_apply_relabels_exact_row_and_backup_preserves_unrelated_tables(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)

    manifest = _run(
        _runner(FakeFetcher([_official(local)]), now=lambda: NOW),
        _request(db, apply=True),
    )

    repaired = _read_row(db)
    assert repaired["source"] == REPAIR_SOURCE
    assert repaired["close"] == local["close"]
    assert repaired["created_at"] == local["created_at"]
    assert manifest["result"] == {"status": "applied", "applied": 1}
    backup = Path(manifest["backup"]["path"])
    assert backup.parent == db.parent
    assert len(manifest["backup"]["sha256"]) == 64
    assert manifest["backup"]["quick_check"] == "ok"
    with sqlite3.connect(backup) as conn:
        assert conn.execute("SELECT value FROM unrelated_state WHERE key='sentinel'").fetchone()[0] == "preserve-me"
        assert conn.execute("SELECT source FROM klines").fetchone()[0] == "data_manager_closed"


def test_apply_replaces_mismatched_values_with_official_row(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1, close=999.0)
    official = _official(local, close=105.0)
    _insert(db, local)

    manifest = _run(
        _runner(FakeFetcher([official]), now=lambda: NOW),
        _request(db, apply=True),
    )

    row = _read_row(db)
    assert row["close"] == 105.0
    assert row["source"] == REPAIR_SOURCE
    assert manifest["counts"]["mismatch_replace"] == 1
    assert manifest["times"]["mismatch_replace"][0]["open_time"] == OPEN_1


@pytest.mark.parametrize("fetcher", [FakeFetcher([]), FakeFetcher([], fail=True), FakeFetcher([], raise_error=True)])
def test_official_missing_or_request_error_blocks_entire_apply(tmp_path: Path, fetcher: FakeFetcher) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)

    manifest = _run(_runner(fetcher, now=lambda: NOW), _request(db, apply=True))

    assert manifest["result"]["status"] == "blocked_unresolved"
    assert manifest["counts"]["unresolved"] == 1
    assert _read_row(db)["source"] == "data_manager_closed"
    assert not list(tmp_path.glob("*.bak"))


def test_non_binance_and_custom_intervals_are_rejected(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    _insert(db, _local_row(OPEN_1))

    with pytest.raises(RepairValidationError, match="only exchange=binance"):
        _run(
            _runner(FakeFetcher([]), now=lambda: NOW),
            _request(db, exchanges=("okx",)),
        )
    with pytest.raises(RepairValidationError, match="not a Binance-native interval"):
        _run(
            _runner(FakeFetcher([]), now=lambda: NOW),
            _request(db, intervals=("45m",)),
        )

    custom_db = tmp_path / "custom.db"
    _create_db(custom_db)
    _insert(custom_db, _local_row(OPEN_1, interval="45m"))
    with pytest.raises(RepairValidationError, match="custom series"):
        _run(
            _runner(FakeFetcher([]), now=lambda: NOW),
            _request(custom_db),
        )


def test_apply_requires_confirm_and_backup_must_stay_beside_database(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)
    runner = _runner(FakeFetcher([_official(local)]), now=lambda: NOW)

    with pytest.raises(RepairValidationError, match="apply requires --confirm"):
        _run(
            runner,
            RepairRequest(
                db_path=db,
                report_path=tmp_path / "report.json",
                apply=True,
                confirm=False,
            ),
        )
    outside = tmp_path / "backup"
    with pytest.raises(RepairValidationError, match="backup_dir must be"):
        _run(runner, _request(db, backup_dir=outside))


def test_candidate_cas_drift_rolls_back_without_overwriting_newer_row(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1, close=999.0)
    _insert(db, local)

    def drift(path: Path, _candidates) -> None:
        with sqlite3.connect(path) as conn:
            conn.execute("UPDATE klines SET close=777, updated_at=333 WHERE open_time=?", (OPEN_1,))

    runner = _runner(
        FakeFetcher([_official(local, close=105.0)]),
        now=lambda: NOW,
        before_transaction=drift,
    )
    with pytest.raises(RepairApplyError, match="drifted") as captured:
        _run(runner, _request(db, apply=True))

    row = _read_row(db)
    assert row["close"] == 777
    assert row["source"] == "data_manager_closed"
    assert captured.value.manifest["result"]["status"] == "rolled_back"


def test_mid_batch_exception_rolls_back_every_repair(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    first = _local_row(OPEN_1, close=901.0)
    second = _local_row(OPEN_2, close=902.0)
    _insert(db, first)
    _insert(db, second)

    def fail_second(index: int, _conn: sqlite3.Connection) -> None:
        if index == 1:
            raise RuntimeError("injected write failure")

    runner = _runner(
        FakeFetcher([_official(first, close=101.0), _official(second, close=102.0)]),
        now=lambda: NOW,
        write_fault=fail_second,
    )
    with pytest.raises(RepairApplyError, match="injected write failure"):
        _run(runner, _request(db, apply=True))

    assert _read_row(db, OPEN_1)["close"] == 901.0
    assert _read_row(db, OPEN_2)["close"] == 902.0
    assert _read_row(db, OPEN_1)["source"] == "data_manager_closed"
    assert _read_row(db, OPEN_2)["source"] == "data_manager_closed"


def test_repaired_source_cannot_be_overwritten_by_lower_quality_writer(tmp_path: Path, monkeypatch) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1, close=999.0)
    _insert(db, local)
    _run(
        _runner(FakeFetcher([_official(local, close=105.0)]), now=lambda: NOW),
        _request(db, apply=True),
    )

    from app.data_engine.storage import klines_repo

    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db)
    low_quality = _local_row(OPEN_1, close=555.0)
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1h",
        [{key: low_quality[key] for key in (
            "open_time", "close_time", "open", "high", "low", "close",
            "volume", "quote_volume", "trades", "taker_buy_base", "taker_buy_quote",
        )}],
        source="data_manager_closed",
        exchange="binance",
        market_type="spot",
    )

    row = _read_row(db)
    assert row["close"] == 105.0
    assert row["source"] == REPAIR_SOURCE


def test_report_path_cannot_overlap_database_or_overwrite_existing_file(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)
    before = db.read_bytes()
    fetcher = FakeFetcher([_official(local)])

    with pytest.raises(RepairValidationError, match="must not overlap"):
        _run(
            _runner(fetcher, now=lambda: NOW),
            RepairRequest(db_path=db, report_path=db),
        )
    assert db.read_bytes() == before
    assert fetcher.tasks == []

    existing = tmp_path / "existing-report.json"
    existing.write_text("preserve-me", encoding="utf-8")
    with pytest.raises(RepairValidationError, match="already exists"):
        _run(
            _runner(fetcher, now=lambda: NOW),
            RepairRequest(db_path=db, report_path=existing),
        )
    assert existing.read_text("utf-8") == "preserve-me"
    assert db.read_bytes() == before


def test_report_requires_json_suffix_to_exclude_backup_namespace(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)

    with pytest.raises(RepairValidationError, match=r"\.json suffix"):
        _run(
            _runner(FakeFetcher([]), now=lambda: NOW),
            RepairRequest(
                db_path=db,
                report_path=tmp_path / "candlescope.db.pre-kline-repair.bak",
            ),
        )


def test_incomplete_official_enhancements_block_entire_apply(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)
    incomplete = _official(local)
    incomplete.enhanced_fields = frozenset()

    manifest = _run(
        _runner(FakeFetcher([incomplete]), now=lambda: NOW),
        _request(db, apply=True),
    )

    assert manifest["result"]["status"] == "blocked_unresolved"
    assert "missing enhanced fields" in manifest["times"]["unresolved"][0]["reason"]
    row = _read_row(db)
    assert row["source"] == "data_manager_closed"
    assert row["quote_volume"] == local["quote_volume"]
    assert not list(tmp_path.glob("*.bak"))


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        (lambda bar: setattr(bar, "close", float("nan")), "close must be finite"),
        (lambda bar: setattr(bar, "volume", -1.0), "non-negative"),
        (lambda bar: setattr(bar, "high", 99.0), "OHLC values violate"),
        (lambda bar: setattr(bar, "close_time", bar.close_time + 1), "bucket boundary"),
    ],
    ids=("non-finite", "negative-volume", "ohlc-bounds", "close-time"),
)
def test_malformed_official_values_block_apply(
    tmp_path: Path,
    mutation,
    reason: str,
) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)
    malformed = _official(local)
    mutation(malformed)

    manifest = _run(
        _runner(FakeFetcher([malformed]), now=lambda: NOW),
        _request(db, apply=True),
    )

    assert manifest["result"]["status"] == "blocked_unresolved"
    assert reason in manifest["times"]["unresolved"][0]["reason"]
    assert _read_row(db)["source"] == "data_manager_closed"


def test_duplicate_official_open_time_blocks_apply(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)

    manifest = _run(
        _runner(
            FakeFetcher([_official(local), _official(local)]),
            now=lambda: NOW,
        ),
        _request(db, apply=True),
    )

    assert manifest["result"]["status"] == "blocked_unresolved"
    assert "duplicate_official_open_time" in manifest["times"]["unresolved"][0]["reason"]
    assert _read_row(db)["source"] == "data_manager_closed"


def test_current_unclosed_bucket_is_never_promoted(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    current_open = int(NOW.timestamp() * 1000)
    local = _local_row(current_open)
    _insert(db, local)

    manifest = _run(
        _runner(FakeFetcher([_official(local)]), now=lambda: NOW),
        _request(db, apply=True),
    )

    assert manifest["result"]["status"] == "blocked_unresolved"
    assert "current/unclosed bucket" in manifest["times"]["unresolved"][0]["reason"]
    assert _read_row(db, current_open)["source"] == "data_manager_closed"


def test_source_database_quick_check_failure_blocks_before_backup(
    tmp_path: Path,
    monkeypatch,
) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)
    runner = _runner(FakeFetcher([_official(local)]), now=lambda: NOW)
    monkeypatch.setattr(runner, "_quick_check", lambda _path: "page 7 is corrupt")

    manifest = _run(runner, _request(db, apply=True))

    assert manifest["result"]["status"] == "blocked_database_integrity"
    assert manifest["database_quick_check"] == "page 7 is corrupt"
    assert _read_row(db)["source"] == "data_manager_closed"
    assert not list(tmp_path.glob("*.bak"))


def test_only_official_https_endpoints_are_accepted_and_recorded(tmp_path: Path) -> None:
    with pytest.raises(RepairValidationError, match="official HTTPS origin"):
        KlineRepairRunner(
            FakeFetcher([]),
            official_endpoints={"spot": ("http://evil.example",)},
        )

    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1)
    _insert(db, local)
    endpoints = {
        "spot": ("https://api.binance.com", "https://api1.binance.com"),
        "futures": ("https://fapi.binance.com",),
    }
    runner = KlineRepairRunner(
        FakeFetcher([_official(local)]),
        official_endpoints=endpoints,
        endpoint_snapshot=lambda: {
            "spot": "https://api1.binance.com",
            "futures": "https://fapi.binance.com",
        },
        now=lambda: NOW,
    )

    manifest = _run(runner, _request(db))

    assert manifest["official_fetch"] == {
        "provider": "binance_rest",
        "official_https_only": True,
        "configured_endpoints": {
            "spot": ["https://api.binance.com", "https://api1.binance.com"],
            "futures": ["https://fapi.binance.com"],
        },
        "active_endpoints": {
            "spot": "https://api1.binance.com",
            "futures": "https://fapi.binance.com",
        },
    }


def test_sparse_candidate_fetch_budget_covers_full_task_span(tmp_path: Path) -> None:
    assert _repair_fetch_bar_budget(1) == 1
    assert _repair_fetch_bar_budget(10_000) == 1_999

    db = tmp_path / "candlescope.db"
    _create_db(db)
    first = _local_row(OPEN_1)
    third = _local_row(OPEN_1 + 2 * 3_600_000)
    _insert(db, first)
    _insert(db, third)
    fetcher = FakeFetcher([_official(first), _official(third)])

    manifest = _run(
        _runner(fetcher, now=lambda: NOW),
        _request(db),
    )

    assert manifest["result"]["status"] == "dry_run_ready"
    assert len(fetcher.tasks) == 1
    assert fetcher.tasks[0].estimated_bars == 3


def test_apply_with_no_candidates_is_blocked(tmp_path: Path) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)

    manifest = _run(
        _runner(FakeFetcher([]), now=lambda: NOW),
        _request(db, apply=True),
    )

    assert manifest["result"] == {"status": "blocked_no_candidates", "applied": 0}
    assert not list(tmp_path.glob("*.bak"))


def test_cli_timestamp_requires_timezone_and_epoch_milliseconds() -> None:
    with pytest.raises(ValueError, match="include Z"):
        repair_cli._timestamp("2026-07-10T10:00:00")
    with pytest.raises(ValueError, match="epoch seconds are not accepted"):
        repair_cli._timestamp("1783658400")
    assert repair_cli._timestamp("2026-07-10T10:00:00Z") == 1_783_677_600_000
    assert repair_cli._timestamp("2026-07-10T10:00:00+08:00") == 1_783_648_800_000


def test_manifest_collision_after_commit_reports_committed_state(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    db = tmp_path / "candlescope.db"
    _create_db(db)
    local = _local_row(OPEN_1, close=999.0)
    _insert(db, local)
    report = tmp_path / "repair-report.json"

    def create_report_race(_path: Path, _candidates) -> None:
        report.write_text("concurrent-report", encoding="utf-8")

    runner = _runner(
        FakeFetcher([_official(local, close=105.0)]),
        now=lambda: NOW,
        before_transaction=create_report_race,
    )
    with pytest.raises(RepairApplyError) as captured:
        _run(
            runner,
            RepairRequest(
                db_path=db,
                report_path=report,
                apply=True,
                confirm=True,
            ),
        )

    assert captured.value.manifest["result"]["status"] == "applied_manifest_write_failed"
    assert _read_row(db)["close"] == 105.0
    assert report.read_text("utf-8") == "concurrent-report"

    async def committed_failure(_request):
        raise RepairApplyError(
            "database repair committed but manifest failed",
            {"result": {"status": "applied_manifest_write_failed", "applied": 1}},
        )

    monkeypatch.setattr(repair_cli, "run_with_default_fetcher", committed_failure)
    args = repair_cli.parse_args(
        ["--db", str(db), "--apply", "--confirm"]
    )
    assert asyncio.run(repair_cli._run(args)) == 3
    stderr = capsys.readouterr().err
    assert "repair committed; manifest write failed" in stderr
    assert "repair rolled back" not in stderr
