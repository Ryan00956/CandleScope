from __future__ import annotations

import argparse
import json
import os
import sqlite3
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.account_history import (
    EXACT_ACCOUNT_FIDELITY,
    verify_account_history_archive,
)
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import (
    ReplayV2CommandType,
    TrainingRunCreateRequest,
)
from scripts.import_replay_account_history import _run as import_account_history
from tests.fixtures.replay.account_history import (
    account_rule_fixture,
    build_account_history_archive,
)
from tests.fixtures.replay.fakes import FixtureIdentity, make_bar
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    ROW_COUNT,
    START_MS,
    ImmutableReplayHistoryFake,
    SessionIdFactory,
    replay_settings,
)
from tests.fixtures.replay.trade_service_fakes import (
    TRADE_NOW_MS,
    TRADE_REPLAY_START_MS,
)
from tests.test_replay_v2_training_phase5 import (
    _acquire,
    _command,
    _multi_trade_sources,
    _trade_request,
)


pytestmark = pytest.mark.anyio

REPLAY_START = START_MS + 4 * INTERVAL_MS
ARCHIVE_END = REPLAY_START + 20 * INTERVAL_MS


async def test_operator_account_history_import_cli_contract(tmp_path: Path) -> None:
    database = tmp_path / "operator-import.db"
    archive = tmp_path / "operator-source.sqlite3"
    build_account_history_archive(
        archive,
        archive_id="operator-import-fixture",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    result = await import_account_history(
        argparse.Namespace(
            replay_db=database,
            archive=archive,
            archive_root=None,
            max_archive_bytes=64 * 1024 * 1024,
        )
    )
    assert result["protocol"] == "replay.account-history.import.v1"
    assert result["archive"]["archive_id"] == "operator-import-fixture"
    assert result["archive"]["health"] == "READY"
    assert str(result["archive"]["proof_hash"]).startswith("sha256:")
    assert result["inventory_summary"] == {
        "feature_enabled": True,
        "max_archive_bytes": 64 * 1024 * 1024,
        "archive_count": 1,
        "ready_archive_count": 1,
        "total_bytes": archive.stat().st_size,
    }
    with sqlite3.connect(database) as connection:
        assert connection.execute(
            """
            SELECT trusted_origin
            FROM replay_account_history_archive
            WHERE archive_id = 'operator-import-fixture'
            """
        ).fetchone() == ("OPERATOR_VERIFIED_CAPTURE",)
        assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def _repository(*symbols: str) -> ImmutableReplayHistoryFake:
    repository = ImmutableReplayHistoryFake()
    for offset, symbol in enumerate(symbols):
        repository.add_rows(
            FixtureIdentity("binance", "futures", symbol),
            "1m",
            [
                make_bar(
                    START_MS + index * INTERVAL_MS,
                    price=str(100 + offset * 100 + index),
                )
                for index in range(ROW_COUNT)
            ],
        )
    return repository


async def _service(
    database: Path,
    *,
    enabled: bool = True,
    symbols: tuple[str, ...] = ("BTCUSDT",),
    max_archive_bytes: int = 64 * 1024 * 1024,
) -> ReplayService:
    settings = replay_settings(database)
    service = ReplayService(
        settings=replace(
            settings,
            replay_account_history_enabled=enabled,
            replay_account_history_max_archive_bytes=max_archive_bytes,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        repository=_repository(*symbols),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("phase16-adapter"),
        training_run_id_factory=SessionIdFactory("phase16-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _agg_service(
    database: Path,
    archive_root: Path,
    *,
    symbols: tuple[str, ...] = ("BTCUSDT",),
) -> ReplayService:
    repository, raw_trade_archive = _multi_trade_sources(archive_root, symbols)
    settings = replay_settings(database)
    service = ReplayService(
        settings=replace(
            settings,
            replay_account_history_enabled=True,
            replay_account_history_max_archive_bytes=64 * 1024 * 1024,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: TRADE_NOW_MS),
        repository=repository,
        raw_trade_archive=raw_trade_archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("phase16-agg-adapter"),
        training_run_id_factory=SessionIdFactory("phase16-agg-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _base_request(service: ReplayService) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=12 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=False,
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v3",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 16 exact account",
            "source_kind": "BAR",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": REPLAY_START,
            "warmup_bars": 2,
            "forward_cache_ms": 12 * INTERVAL_MS,
            "random_seed": 16,
            "initial_equity": "10000",
            "max_leverage": "8",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "0",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "NONE",
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "position_mode": "ONE_WAY",
            "account_data_mode": "APPROX_PROXY",
            "funding_mode": "OFF",
            "allow_rule_changes": False,
        }
    )


def _exact_request(
    base: TrainingRunCreateRequest,
    *,
    reference: object | None = None,
    funding: bool = True,
    initial_equity: str | None = None,
    margin_mode: str = "CROSS",
) -> TrainingRunCreateRequest:
    payload = base.to_dict()
    payload.update(
        {
            "account_data_mode": "HISTORICAL_EXACT",
            "account_history_ref": reference,
            "funding_mode": "HISTORICAL_EXACT" if funding else "OFF",
            "margin_mode": margin_mode,
            "position_mode": "ONE_WAY",
        }
    )
    if initial_equity is not None:
        payload["initial_equity"] = initial_equity
    return TrainingRunCreateRequest.from_dict(payload)


async def _import_and_plan(
    service: ReplayService,
    archive: Path,
    request: TrainingRunCreateRequest,
) -> tuple[TrainingRunCreateRequest, dict[str, object]]:
    assert service.training is not None
    imported = await service.training.account_history.import_archive(archive)
    plan = await service.training.segment_plan(request)
    account_plan = plan["account_history"]
    assert isinstance(account_plan, dict)
    assert account_plan["capability_state"] == "AVAILABLE_EXACT"
    reference = account_plan["account_history_ref"]
    assert isinstance(reference, dict)
    return _exact_request(
        request,
        reference=reference,
        funding=request.funding_mode.value == "HISTORICAL_EXACT",
        initial_equity=request.initial_equity,
        margin_mode=request.margin_mode.value,
    ), imported


async def _send(
    service: ReplayService,
    *,
    run_id: str,
    session_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    payload: dict[str, object],
) -> dict[str, object]:
    session = await service.get_session(session_id)
    return await service.training.command(  # type: ignore[union-attr]
        run_id,
        _command(run_id, command_id, command_type, session, payload),
    )


def test_account_archive_verifier_is_stable_and_rejects_component_drift(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "account.sqlite3"
    metadata = build_account_history_archive(
        archive,
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    first = verify_account_history_archive(archive)
    second = verify_account_history_archive(archive)
    assert first == second
    assert first.dataset_epoch == metadata["dataset_epoch"]
    assert first.event_chain_tail == metadata["event_chain_tail"]
    assert first.rule_count == 2
    assert first.mark_count == 41
    assert first.funding_count == 5

    bad_decimal = tmp_path / "bad-decimal.sqlite3"
    build_account_history_archive(
        bad_decimal,
        archive_id="bad-decimal",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    with sqlite3.connect(bad_decimal) as connection:
        connection.execute(
            "UPDATE mark_index_event SET mark_price = '100.0' WHERE sequence = 1"
        )
    with pytest.raises(ValueError, match="canonical Decimal"):
        verify_account_history_archive(bad_decimal)

    bad_gap = tmp_path / "bad-gap.sqlite3"
    build_account_history_archive(
        bad_gap,
        archive_id="bad-gap",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    with sqlite3.connect(bad_gap) as connection:
        connection.execute(
            """
            UPDATE mark_index_event
            SET event_time_ms = event_time_ms + 1000
            WHERE sequence = 2
            """
        )
    with pytest.raises(ValueError, match="max_mark_gap_ms"):
        verify_account_history_archive(bad_gap)

    bad_funding = tmp_path / "bad-funding.sqlite3"
    build_account_history_archive(
        bad_funding,
        archive_id="bad-funding",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    with sqlite3.connect(bad_funding) as connection:
        connection.execute(
            "UPDATE funding_event SET mark_price = '1' WHERE sequence = 1"
        )
    with pytest.raises(ValueError, match="funding_event mark"):
        verify_account_history_archive(bad_funding)

    bad_chain = tmp_path / "bad-chain.sqlite3"
    build_account_history_archive(
        bad_chain,
        archive_id="bad-chain",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    with sqlite3.connect(bad_chain) as connection:
        connection.execute(
            """
            UPDATE archive_event
            SET event_hash = 'sha256:' || printf('%064x', 1)
            WHERE event_sequence = 3
            """
        )
    with pytest.raises(ValueError, match="hash mismatch"):
        verify_account_history_archive(bad_chain)


def test_account_archive_verifier_rejects_schema_sequence_tier_and_proxy_drift(
    tmp_path: Path,
) -> None:
    column_drift = tmp_path / "column-drift.sqlite3"
    build_account_history_archive(
        column_drift,
        archive_id="column-drift",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    with sqlite3.connect(column_drift) as connection:
        connection.execute("ALTER TABLE mark_index_event ADD COLUMN proxy_close TEXT")
    with pytest.raises(ValueError, match="columns drifted"):
        verify_account_history_archive(column_drift)

    missing_index = tmp_path / "missing-index.sqlite3"
    build_account_history_archive(
        missing_index,
        archive_id="missing-index",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    with sqlite3.connect(missing_index) as connection:
        connection.execute(
            "UPDATE mark_index_event SET index_price = '' WHERE sequence = 1"
        )
    with pytest.raises(ValueError, match="mark.index_price"):
        verify_account_history_archive(missing_index)

    sequence_gap = tmp_path / "sequence-gap.sqlite3"
    build_account_history_archive(
        sequence_gap,
        archive_id="sequence-gap",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        rule_changes=(
            account_rule_fixture(
                sequence=1,
                effective_time_ms=REPLAY_START,
                source_kind="BAR",
            ),
            account_rule_fixture(
                sequence=3,
                effective_time_ms=REPLAY_START + 5 * INTERVAL_MS,
                source_kind="BAR",
            ),
        ),
    )
    with pytest.raises(ValueError, match="sequence is not contiguous"):
        verify_account_history_archive(sequence_gap)

    tier_gap_rule = account_rule_fixture(
        sequence=1,
        effective_time_ms=REPLAY_START,
        source_kind="BAR",
        max_notional="100000",
    )
    tiers = tier_gap_rule["maintenance_tiers"]
    assert isinstance(tiers, list)
    tiers[-1] = {**tiers[-1], "notional_cap": "99999"}
    tier_gap = tmp_path / "tier-gap.sqlite3"
    build_account_history_archive(
        tier_gap,
        archive_id="tier-gap",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        rule_changes=(tier_gap_rule,),
    )
    with pytest.raises(ValueError, match="tiers do not cover max_notional"):
        verify_account_history_archive(tier_gap)

    public_proxy = tmp_path / "public-kline-proxy.sqlite3"
    build_account_history_archive(
        public_proxy,
        archive_id="public-kline-proxy",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        source="OPERATOR_CAPTURED_PUBLIC_KLINE_PROXY",
        provenance="BINANCE_PUBLIC_KLINE_DERIVED",
    )
    with pytest.raises(ValueError, match="public K-line proxy"):
        verify_account_history_archive(public_proxy)

    unverified = tmp_path / "unverified.sqlite3"
    build_account_history_archive(
        unverified,
        archive_id="unverified",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    with pytest.raises(ValueError, match="trusted_origin"):
        verify_account_history_archive(unverified, trusted_origin="PUBLIC_API")


async def test_exact_plan_create_binding_ordering_funding_and_restart(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase16.db"
    archive = tmp_path / "source-account.sqlite3"
    build_account_history_archive(
        archive,
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        funding_anchor_ms=REPLAY_START + 2 * INTERVAL_MS - 1,
    )
    service = await _service(database)
    run_id = ""
    session_id = ""
    funding_count = 0
    try:
        base = await _base_request(service)
        exact_without_ref = _exact_request(base)
        exact, imported = await _import_and_plan(
            service,
            archive,
            exact_without_ref,
        )
        assert imported["health"] == "READY"
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase16-acquire",
        )
        initial = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        portfolio = initial["portfolio"]
        assert portfolio["account_history"]["mode"] == "HISTORICAL_EXACT"
        assert portfolio["account_history"]["status"] == "ACTIVE"
        assert portfolio["fidelity"]["mark"] == "HISTORICAL_EXACT_ARCHIVE_MARK"
        assert portfolio["positions"] == []
        assert initial["tracks"][0]["position"]["mark_price"] == "100"

        with pytest.raises(TrainingRunError) as bad_step:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="bad-quantity-step",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": "bad-quantity-step",
                    "side": "BUY",
                    "order_type": "MARKET",
                    "quantity": "0.15",
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
        assert bad_step.value.code == "ACCOUNT_HISTORY_QUANTITY_FILTER"

        opened = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="exact-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "exact-open",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        assert (
            opened["data"]["portfolio"]["account_history"]["auditor"]["status"]
            == "PASS"
        )
        for index in range(2):
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"exact-step-{index}",
                command_type=ReplayV2CommandType.STEP_BASE,
                payload={"count": 1},
            )
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        portfolio = projection["portfolio"]
        assert float(portfolio["funding_cashflow"]) < 0
        assert portfolio["ledger"]["reconciliation_delta"] == "0"
        assert portfolio["account_history"]["auditor"]["status"] == "PASS"
        assert (
            portfolio["liquidation_channels"]["simulated_account"]["source"]
            == "MODELLED_ACCOUNT"
        )
        assert (
            portfolio["liquidation_channels"]["historical_market"]["fidelity"]
            == "UNSUPPORTED_NO_HISTORY"
        )
        events = await service.training.store.global_events(run_id)  # type: ignore[union-attr]
        settlement = [
            event
            for event in events
            if event["actual_event_time_ms"] == REPLAY_START + 2 * INTERVAL_MS - 1
        ]
        assert [event["event_phase"] for event in settlement] == [20, 30, 40]
        assert any(
            event["event_phase"] == 30
            and event["actual_event_time_ms"] == REPLAY_START + 30_000
            for event in events
        )
        with sqlite3.connect(database) as connection:
            funding_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_training_funding_settlement
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            assert funding_count == 1
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_account_history_ref
                    WHERE run_id = ? AND active = 1
                    """,
                    (run_id,),
                ).fetchone()[0]
                == 1
            )
    finally:
        await service.shutdown(step_timeout=1.0)
    restored = await _service(database)
    try:
        projection = await restored.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert projection["portfolio"]["account_history"]["status"] == "ACTIVE"
        audit = await restored.training.audit_account(run_id)  # type: ignore[union-attr]
        assert audit["status"] == "PASS", audit
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_training_funding_settlement
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
                == funding_count
            )
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_exact_account_only_waves_batch_until_market_barrier(
    tmp_path: Path,
) -> None:
    database = tmp_path / "account-wave-batching.db"
    archive = tmp_path / "account-wave-batching.sqlite3"
    build_account_history_archive(
        archive,
        archive_id="account-wave-batching",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        funding_interval_ms=0,
        price_at=lambda timestamp: str(100 + (timestamp - REPLAY_START) // INTERVAL_MS),
    )
    service = await _service(database)
    try:
        base = await _base_request(service)
        exact, _ = await _import_and_plan(
            service,
            archive,
            _exact_request(base, funding=False),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="account-wave-batching-acquire",
        )
        before = await service.get_session(session_id)
        stepped = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="account-wave-batching-step",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )

        # A 30-second exact mark exists between two 1-minute BAR events. It is
        # durably applied and globally ordered, but does not create a separate
        # adapter ADVANCE_BY transaction. The target BAR is the sole barrier.
        assert stepped["revision"] == before["snapshot"]["revision"] + 1
        stable = stepped["data"]["stable_order"]
        assert stable == sorted(
            stable,
            key=lambda event: (
                event["actual_event_time_ms"],
                event["event_phase"],
                event["market_track_stable_id"],
                event["source_sequence"],
            ),
        )
        assert any(
            event["event_phase"] == 30
            and before["snapshot"]["cursor"]["virtual_time_ms"]
            < event["actual_event_time_ms"]
            < stepped["cursor"]["virtual_time_ms"]
            for event in stable
        )
        assert sum(event["event_phase"] == 20 for event in stable) == 1
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert (
            projection["portfolio"]["account_history"]["auditor"]["status"] == "PASS"
        ), projection["portfolio"]["account_history"]["auditor"]
        with sqlite3.connect(database) as connection:
            command_types = [
                json.loads(row[0])["type"]
                for row in connection.execute(
                    """
                    SELECT command_json FROM replay_command_log
                    WHERE session_id = ? ORDER BY result_sequence
                    """,
                    (session_id,),
                ).fetchall()
            ]
        assert "advance_by" not in command_types
        assert command_types.count("step") == 1
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_create_fail_closed_for_flag_random_ref_and_budget(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "account.sqlite3"
    build_account_history_archive(
        archive,
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    disabled = await _service(tmp_path / "disabled.db", enabled=False)
    try:
        base = await _base_request(disabled)
        exact = _exact_request(base)
        plan = await disabled.training.segment_plan(exact)  # type: ignore[union-attr]
        assert plan["account_history"]["feature_enabled"] is False
        with pytest.raises(TrainingRunError) as rejected:
            await disabled.training.create_run(exact)  # type: ignore[union-attr]
        assert rejected.value.code == "ACCOUNT_HISTORY_DISABLED"
    finally:
        await disabled.shutdown(step_timeout=1.0)

    budget = await _service(
        tmp_path / "budget.db",
        max_archive_bytes=1024,
    )
    try:
        with pytest.raises(TrainingRunError) as rejected:
            await budget.training.account_history.import_archive(archive)  # type: ignore[union-attr]
        assert rejected.value.code == "ACCOUNT_HISTORY_ARCHIVE_BUDGET_EXCEEDED"
    finally:
        await budget.shutdown(step_timeout=1.0)

    enabled = await _service(tmp_path / "stale.db")
    try:
        base = await _base_request(enabled)
        exact = _exact_request(base)
        await enabled.training.account_history.import_archive(archive)  # type: ignore[union-attr]
        plan = await enabled.training.segment_plan(exact)  # type: ignore[union-attr]
        reference = dict(plan["account_history"]["account_history_ref"])
        stale = {**reference, "checksum_sha256": "sha256:" + "f" * 64}
        with pytest.raises(TrainingRunError) as rejected:
            await enabled.training.create_run(_exact_request(base, reference=stale))  # type: ignore[union-attr]
        assert rejected.value.code == "ACCOUNT_HISTORY_REF_STALE"
        random_payload = base.to_dict()
        random_payload.update(
            {
                "start_mode": "RANDOM",
                "requested_start_ms": None,
                "account_data_mode": "HISTORICAL_EXACT",
                "account_history_ref": reference,
            }
        )
        random_request = TrainingRunCreateRequest.from_dict(random_payload)
        with pytest.raises(TrainingRunError) as rejected:
            await enabled.training.create_run(random_request)  # type: ignore[union-attr]
        assert rejected.value.code == "ACCOUNT_HISTORY_MANUAL_START_REQUIRED"
    finally:
        await enabled.shutdown(step_timeout=1.0)


async def test_exact_create_rejects_coverage_identity_and_public_proxy(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "identity.db")
    try:
        base = await _base_request(service)

        short = tmp_path / "short.sqlite3"
        build_account_history_archive(
            short,
            archive_id="short-coverage",
            range_start_ms=REPLAY_START,
            range_end_ms=REPLAY_START + 6 * INTERVAL_MS,
            rule_changes=(
                account_rule_fixture(
                    sequence=1,
                    effective_time_ms=REPLAY_START,
                    source_kind="BAR",
                ),
                account_rule_fixture(
                    sequence=2,
                    effective_time_ms=REPLAY_START + 5 * INTERVAL_MS,
                    source_kind="BAR",
                    price_tick="0.5",
                    max_leverage="5",
                ),
            ),
        )
        await service.training.account_history.import_archive(short)  # type: ignore[union-attr]
        plan = await service.training.segment_plan(_exact_request(base))  # type: ignore[union-attr]
        assert plan["account_history"]["capability_state"] == "UNSUPPORTED_NO_HISTORY"
        assert plan["account_history"]["account_history_ref"] is None

        wrong_symbol = tmp_path / "eth.sqlite3"
        build_account_history_archive(
            wrong_symbol,
            archive_id="wrong-symbol",
            symbol="ETHUSDT",
            range_start_ms=REPLAY_START,
            range_end_ms=ARCHIVE_END,
        )
        imported_symbol = await service.training.account_history.import_archive(  # type: ignore[union-attr]
            wrong_symbol
        )
        wrong_ref = {
            "schema_version": "replay.account-history-ref.v1",
            "archive_id": imported_symbol["archive_id"],
            "dataset_epoch": imported_symbol["dataset_epoch"],
            "checksum_sha256": imported_symbol["checksum_sha256"],
        }
        with pytest.raises(TrainingRunError) as rejected:
            await service.training.create_run(  # type: ignore[union-attr]
                _exact_request(base, reference=wrong_ref, funding=False)
            )
        assert rejected.value.code == "ACCOUNT_HISTORY_IDENTITY_MISMATCH"

        wrong_settlement = tmp_path / "usdc.sqlite3"
        build_account_history_archive(
            wrong_settlement,
            archive_id="wrong-settlement",
            settlement_asset="USDC",
            range_start_ms=REPLAY_START,
            range_end_ms=ARCHIVE_END,
        )
        imported_settlement = (
            await service.training.account_history.import_archive(wrong_settlement)  # type: ignore[union-attr]
        )
        settlement_ref = {
            "schema_version": "replay.account-history-ref.v1",
            "archive_id": imported_settlement["archive_id"],
            "dataset_epoch": imported_settlement["dataset_epoch"],
            "checksum_sha256": imported_settlement["checksum_sha256"],
        }
        with pytest.raises(TrainingRunError) as rejected:
            await service.training.create_run(  # type: ignore[union-attr]
                _exact_request(base, reference=settlement_ref, funding=False)
            )
        assert rejected.value.code == "ACCOUNT_HISTORY_IDENTITY_MISMATCH"

        public_proxy = tmp_path / "public-proxy.sqlite3"
        build_account_history_archive(
            public_proxy,
            archive_id="public-proxy",
            range_start_ms=REPLAY_START,
            range_end_ms=ARCHIVE_END,
            source="OPERATOR_CAPTURED_PUBLIC_KLINE_PROXY",
            provenance="PUBLIC_KLINE_RECONSTRUCTED_ACCOUNT",
        )
        with pytest.raises(ValueError, match="public K-line proxy"):
            await service.training.account_history.import_archive(public_proxy)  # type: ignore[union-attr]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_owned_archive_tamper_degrades_without_proxy_fallback(
    tmp_path: Path,
) -> None:
    database = tmp_path / "tamper.db"
    source = tmp_path / "source.sqlite3"
    build_account_history_archive(
        source,
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _service(database)
    try:
        base = await _base_request(service)
        exact, _ = await _import_and_plan(
            service,
            source,
            _exact_request(base),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="tamper-acquire",
        )
        owned = next(
            (service.training.account_history.root / "objects").glob("*.sqlite3")  # type: ignore[union-attr]
        )
        original_stat = owned.stat()
        with sqlite3.connect(owned) as connection:
            connection.execute(
                "UPDATE mark_index_event SET mark_price = '999' WHERE sequence = 2"
            )
        os.utime(
            owned,
            ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
        )
        with pytest.raises(TrainingRunError) as rejected:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="tamper-step",
                command_type=ReplayV2CommandType.STEP_BASE,
                payload={"count": 1},
            )
        assert rejected.value.code == "ACCOUNT_HISTORY_ARCHIVE_DEGRADED"
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert projection["portfolio"]["account_history"]["status"] == "DEGRADED"
        assert projection["tracks"][0]["state"] == "DEGRADED"
        assert projection["tracks"][0]["position"]["mark_price"] != "999"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_account_auditor_detects_ledger_tamper(tmp_path: Path) -> None:
    database = tmp_path / "audit.db"
    source = tmp_path / "source.sqlite3"
    build_account_history_archive(
        source,
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _service(database)
    try:
        base = await _base_request(service)
        exact, _ = await _import_and_plan(
            service,
            source,
            _exact_request(base, funding=False),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="audit-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="audit-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "audit-open",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        clean = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert clean["status"] == "PASS"
        assert (
            clean["snapshot"]["authoritative_projection_verification"]
            == "VERIFIED_PINNED_ARCHIVE"
        )
        with sqlite3.connect(database) as connection:
            original_mark = connection.execute(
                """
                SELECT mark_price FROM replay_account_history_projection
                WHERE run_id = ? AND track_id = 'track-1'
                """,
                (run_id,),
            ).fetchone()[0]
            original_fee = connection.execute(
                """
                SELECT configured_fee FROM replay_training_contract_fill
                WHERE run_id = ? AND track_id = 'track-1'
                """,
                (run_id,),
            ).fetchone()[0]
            connection.execute(
                """
                UPDATE replay_account_history_projection SET mark_price = '999'
                WHERE run_id = ? AND track_id = 'track-1'
                """,
                (run_id,),
            )
        projection_failed = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert projection_failed["status"] == "FAIL"
        assert "projection[track-1].mark_price" in {
            str(item["field"]) for item in projection_failed["differences"]
        }
        with sqlite3.connect(database) as connection:
            connection.execute(
                """
                UPDATE replay_account_history_projection SET mark_price = ?
                WHERE run_id = ? AND track_id = 'track-1'
                """,
                (original_mark, run_id),
            )
            connection.execute(
                """
                UPDATE replay_training_contract_fill SET configured_fee = '0'
                WHERE run_id = ? AND track_id = 'track-1'
                """,
                (run_id,),
            )
        fill_failed = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert fill_failed["status"] == "FAIL"
        assert any(
            str(item["field"]).endswith(".configured_fee")
            for item in fill_failed["differences"]
        )
        with sqlite3.connect(database) as connection:
            connection.execute(
                """
                UPDATE replay_training_contract_fill SET configured_fee = ?
                WHERE run_id = ? AND track_id = 'track-1'
                """,
                (original_fee, run_id),
            )
            connection.execute(
                """
                UPDATE replay_training_contract_ledger
                SET cash_delta = '999'
                WHERE run_id = ? AND ledger_sequence = 1
                """,
                (run_id,),
            )
        failed = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert failed["status"] == "FAIL"
        assert {str(item["field"]) for item in failed["differences"]} & {
            "ledger[1].entry_hash",
            "cash_balance",
        }
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_mark_drives_modelled_liquidation_not_market_feed(
    tmp_path: Path,
) -> None:
    database = tmp_path / "liquidation.db"
    source = tmp_path / "liquidation-source.sqlite3"
    build_account_history_archive(
        source,
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        rule_changes=(
            account_rule_fixture(
                sequence=1,
                effective_time_ms=REPLAY_START,
                source_kind="BAR",
                contract_size="10",
            ),
        ),
        price_at=lambda timestamp: "100" if timestamp == REPLAY_START else "1",
    )
    service = await _service(database)
    try:
        base = await _base_request(service)
        exact, _ = await _import_and_plan(
            service,
            source,
            _exact_request(
                base,
                funding=False,
                initial_equity="989",
            ),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="liquidation-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="liquidation-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "liquidation-open",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="liquidation-step",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        portfolio = projection["portfolio"]
        assert portfolio["liquidations"]
        assert portfolio["liquidations"][0]["state"] == "COMPLETED"
        liquidation = portfolio["liquidations"][0]
        assert liquidation["trigger_virtual_time_ms"] == REPLAY_START + 30_000
        fill_page = await service.training.account_record_page(  # type: ignore[union-attr]
            run_id,
            record_type="FILLS",
            order_scope="ALL",
            track_id=None,
            cursor=None,
            limit=50,
        )
        entry_fill = next(fill for fill in fill_page["items"] if fill["side"] == "BUY")
        assert len(liquidation["legs"]) == 1
        leg = liquidation["legs"][0]
        risk_snapshot = next(
            snapshot
            for snapshot in portfolio["hedge_state"]["risk_snapshots"]
            if snapshot["snapshot_id"] == liquidation["trigger_snapshot_id"]
        )
        proof = next(
            item
            for item in portfolio["hedge_state"]["liquidation_leg_price_proofs"]
            if item["liquidation_leg_id"] == leg["liquidation_leg_id"]
        )
        assert Decimal(leg["bankruptcy_price"]) == Decimal(proof["bankruptcy_price"])
        raw_bankruptcy = Decimal(proof["mark_price"]) - Decimal(
            proof["scope_equity"]
        ) / (Decimal(leg["trigger_quantity"]) * Decimal("10"))
        assert Decimal(leg["bankruptcy_price"]) <= raw_bankruptcy
        assert raw_bankruptcy - Decimal(leg["bankruptcy_price"]) < Decimal(
            proof["price_tick"]
        ), (entry_fill, risk_snapshot, liquidation)
        assert (
            portfolio["liquidation_channels"]["simulated_account"]["fidelity"]
            == EXACT_ACCOUNT_FIDELITY
        )
        assert (
            portfolio["liquidation_channels"]["historical_market"]["fidelity"]
            == "UNSUPPORTED_NO_HISTORY"
        )
        assert portfolio["ledger"]["reconciliation_delta"] == "0"
        assert portfolio["account_history"]["auditor"]["status"] == "PASS"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_agg_exact_stable_order_retry_and_missing_global_event_repair(
    tmp_path: Path,
) -> None:
    database = tmp_path / "agg.db"
    source = tmp_path / "agg-account.sqlite3"
    build_account_history_archive(
        source,
        archive_id="agg-account",
        source_kind="AGG_TRADE",
        range_start_ms=TRADE_REPLAY_START_MS,
        range_end_ms=TRADE_REPLAY_START_MS + 6 * INTERVAL_MS,
        mark_interval_ms=1_000,
        funding_interval_ms=0,
        price_at=lambda timestamp: str(
            100 + (timestamp - TRADE_REPLAY_START_MS) // INTERVAL_MS
        ),
    )
    service = await _agg_service(
        database,
        tmp_path / "agg-trades",
    )
    try:
        base = await _trade_request(service)
        exact, _ = await _import_and_plan(
            service,
            source,
            _exact_request(base, funding=False),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="agg-exact-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="agg-exact-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "agg-exact-open",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        before = await service.get_session(session_id)
        command = _command(
            run_id,
            "agg-exact-step",
            ReplayV2CommandType.STEP_EVENT,
            before,
            {"count": 1},
        )
        first = await service.training.command(run_id, command)  # type: ignore[union-attr]
        retried = await service.training.command(run_id, command)  # type: ignore[union-attr]
        assert retried == first
        stable = first["data"]["stable_order"]
        same_time = [
            event
            for event in stable
            if event["actual_event_time_ms"] == TRADE_REPLAY_START_MS + 1_000
        ]
        assert [
            (event["event_phase"], event["market_track_stable_id"])
            for event in same_time
        ] == [(20, "track-1"), (30, "account:track-1")]

        with sqlite3.connect(database) as connection:
            deleted = connection.execute(
                """
                DELETE FROM replay_training_global_event
                WHERE run_id = ? AND track_id = 'account:track-1'
                  AND actual_event_time_ms = ?
                """,
                (run_id, TRADE_REPLAY_START_MS + 1_000),
            ).rowcount
        assert deleted == 1
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="agg-exact-next",
            command_type=ReplayV2CommandType.STEP_EVENT,
            payload={"count": 1},
        )
        events = await service.training.store.global_events(run_id)  # type: ignore[union-attr]
        repaired = [
            (event["event_phase"], event["track_id"])
            for event in events
            if event["actual_event_time_ms"] == TRADE_REPLAY_START_MS + 1_000
        ]
        assert repaired == [(20, "track-1"), (30, "account:track-1")]
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_training_command
                    WHERE run_id = ? AND command_id = 'agg-exact-step'
                    """,
                    (run_id,),
                ).fetchone()[0]
                == 1
            )
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_account_history_applied_event
                    WHERE run_id = ? AND track_id = 'track-1'
                      AND event_time_ms = ?
                    """,
                    (run_id, TRADE_REPLAY_START_MS + 1_000),
                ).fetchone()[0]
                == 1
            )
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert projection["portfolio"]["account_history"]["auditor"]["status"] == "PASS"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_rule_revision_filters_new_orders_without_rewriting_old_fills(
    tmp_path: Path,
) -> None:
    database = tmp_path / "rules.db"
    source = tmp_path / "rules.sqlite3"
    build_account_history_archive(
        source,
        archive_id="rule-revisions",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        funding_interval_ms=0,
    )
    service = await _service(database)
    try:
        base = await _base_request(service)
        exact, _ = await _import_and_plan(
            service,
            source,
            _exact_request(base, funding=False),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="rules-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="rules-fill-v1",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "rules-fill-v1",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="rules-step-boundary",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 6},
        )
        with pytest.raises(TrainingRunError) as rejected:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="rules-bad-tick",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": "rules-bad-tick",
                    "side": "BUY",
                    "order_type": "LIMIT",
                    "quantity": "1",
                    "reduce_only": False,
                    "limit_price": "100.1",
                    "stop_price": None,
                },
            )
        assert rejected.value.code == "ACCOUNT_HISTORY_PRICE_FILTER"
        assert rejected.value.details["rule_revision"] == 2
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="rules-fill-v2",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "rules-fill-v2",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        with sqlite3.connect(database) as connection:
            rows = connection.execute(
                """
                SELECT fill_json, rule_revision, fee_policy_revision
                FROM replay_training_contract_fill
                WHERE run_id = ? ORDER BY created_at_ms, fill_id
                """,
                (run_id,),
            ).fetchall()
            rules = connection.execute(
                """
                SELECT revision, fidelity FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = 'track-1' ORDER BY revision
                """,
                (run_id,),
            ).fetchall()
        assert [row[1] for row in rows] == [1, 2]
        assert [row[2] for row in rows] == [1, 1]
        assert [row[0] for row in rows]
        assert rules == [
            (1, "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE"),
            (2, "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE"),
        ]
        audit = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert audit["status"] == "PASS", audit
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_multi_full_positions_share_clock_funding_and_audit(
    tmp_path: Path,
) -> None:
    database = tmp_path / "multi.db"
    service = await _service(
        database,
        symbols=("BTCUSDT", "ETHUSDT"),
    )
    try:
        for index, symbol in enumerate(("BTCUSDT", "ETHUSDT"), 1):
            archive = tmp_path / f"{symbol}.sqlite3"
            build_account_history_archive(
                archive,
                archive_id=f"multi-account-{index}",
                symbol=symbol,
                range_start_ms=REPLAY_START,
                range_end_ms=ARCHIVE_END,
                funding_anchor_ms=REPLAY_START + 2 * INTERVAL_MS - 1,
                price_at=lambda timestamp, offset=(index - 1) * 100: str(
                    100 + offset + (timestamp - REPLAY_START) // 30_000
                ),
            )
            await service.training.account_history.import_archive(archive)  # type: ignore[union-attr]
        base = await _base_request(service)
        plan = await service.training.segment_plan(_exact_request(base))  # type: ignore[union-attr]
        exact = _exact_request(
            base,
            reference=plan["account_history"]["account_history_ref"],
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        primary_id = str(created["run"]["adapter_session_id"])
        primary = await service.get_session(primary_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "multi-add-eth",
                ReplayV2CommandType.ADD_TRACK,
                primary,
                {
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "ETHUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "FULL",
                },
            ),
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            command_id="multi-exact-acquire",
        )
        order = {
            "side": "BUY",
            "order_type": "MARKET",
            "quantity": "1",
            "reduce_only": False,
            "limit_price": None,
            "stop_price": None,
        }
        await _send(
            service,
            run_id=run_id,
            session_id=primary_id,
            command_id="multi-btc-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={"client_order_id": "multi-btc-open", **order},
        )
        selected = await _send(
            service,
            run_id=run_id,
            session_id=primary_id,
            command_id="multi-select-eth",
            command_type=ReplayV2CommandType.SELECT_TRACK,
            payload={"track_id": "track-2", "expected_viewer_revision": 0},
        )
        secondary_id = str(selected["session_id"])
        await _send(
            service,
            run_id=run_id,
            session_id=secondary_id,
            command_id="multi-eth-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={"client_order_id": "multi-eth-open", **order},
        )
        await _send(
            service,
            run_id=run_id,
            session_id=secondary_id,
            command_id="multi-exact-step",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        tracks = projection["tracks"]
        assert len(tracks) == 2
        assert len({track["cursor"]["virtual_time_ms"] for track in tracks}) == 1
        assert all(track["position"]["quantity"] == "1" for track in tracks)
        assert len(projection["portfolio"]["account_history"]["bindings"]) == 2
        assert (
            projection["portfolio"]["account_history"]["auditor"]["status"] == "PASS"
        ), projection["portfolio"]["account_history"]["auditor"]
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            stored_equity = connection.execute(
                """
                SELECT current_equity FROM replay_training_run
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()["current_equity"]
            assert stored_equity == projection["portfolio"]["equity"]
            descriptor_domain = service.training.store._review._descriptor_domain(  # noqa: SLF001
                connection,
                run_id=run_id,
            )
            review_projection = service.training.store._review.projection(  # noqa: SLF001
                connection,
                run_id=run_id,
                virtual_time_ms=int(tracks[0]["cursor"]["virtual_time_ms"]),
                source_sequence=int(tracks[0]["cursor"]["source_sequence"]),
            )
            assert descriptor_domain == {
                key: review_projection["domain"][key] for key in descriptor_domain
            }
            event_types = {
                str(row["event_type"])
                for row in connection.execute(
                    """
                    SELECT event_type FROM replay_review_timeline_event
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchall()
            }
            assert "STEP" not in event_types
            assert "ADVANCE_BY" not in event_types
            stored_command = json.loads(
                str(
                    connection.execute(
                        """
                        SELECT command_json FROM replay_training_command
                        WHERE run_id = ? AND command_id = 'multi-exact-step'
                        """,
                        (run_id,),
                    ).fetchone()["command_json"]
                )
            )
            assert stored_command["type"] == "step_base"
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_training_funding_settlement
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
                == 2
            )
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_account_history_ref
                    WHERE run_id = ? AND active = 1
                    """,
                    (run_id,),
                ).fetchone()[0]
                == 2
            )
        settlement_events = [
            event
            for event in await service.training.store.global_events(run_id)  # type: ignore[union-attr]
            if event["actual_event_time_ms"] == REPLAY_START + 2 * INTERVAL_MS - 1
        ]
        assert [
            (event["event_phase"], event["track_id"]) for event in settlement_events
        ] == [
            (20, "track-1"),
            (20, "track-2"),
            (30, "account:track-1"),
            (30, "account:track-2"),
            (40, "account:track-1"),
            (40, "account:track-2"),
        ]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_isolated_margin_and_review_fork_boundary(
    tmp_path: Path,
) -> None:
    source = tmp_path / "isolated.sqlite3"
    build_account_history_archive(
        source,
        archive_id="isolated-account",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        funding_interval_ms=0,
    )
    service = await _service(tmp_path / "isolated.db")
    try:
        base = await _base_request(service)
        exact, _ = await _import_and_plan(
            service,
            source,
            _exact_request(
                base,
                funding=False,
                margin_mode="ISOLATED",
            ),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="isolated-exact-acquire",
        )
        with pytest.raises(TrainingRunError) as missing:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="isolated-exact-missing",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": "isolated-exact-missing",
                    "side": "BUY",
                    "order_type": "MARKET",
                    "quantity": "1",
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
        assert missing.value.code == "ISOLATED_MARGIN_REQUIRED"
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="isolated-exact-allocate",
            command_type=ReplayV2CommandType.ALLOCATE_ISOLATED_MARGIN,
            payload={
                "track_id": "track-1",
                "position_side": None,
                "amount": "1000",
            },
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="isolated-exact-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "isolated-exact-open",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        closed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="isolated-exact-close",
            command_type=ReplayV2CommandType.CLOSE_POSITION,
            payload={"quantity": None},
        )
        assert closed["data"]["portfolio"]["isolated_allocations"] == {}
        assert (
            closed["data"]["portfolio"]["account_history"]["auditor"]["status"]
            == "PASS"
        )
        review = await service.training.start_review(run_id, event_id=None)  # type: ignore[union-attr]
        assert review["run_id"] == run_id
        forked = await service.training.fork_run(  # type: ignore[union-attr]
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        assert forked["parent_run_id"] == run_id
        assert forked["account_audit"]["status"] == "PASS"
        assert forked["run"]["run_id"] != run_id
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_contract_size_leverage_partial_close_and_fee_decimal_golden(
    tmp_path: Path,
) -> None:
    database = tmp_path / "decimal-golden.db"
    source = tmp_path / "decimal-golden.sqlite3"
    tiered_rule = account_rule_fixture(
        sequence=1,
        effective_time_ms=REPLAY_START,
        source_kind="BAR",
        contract_size="10",
        max_leverage="2",
        quote_step="0.01",
        max_notional="100000",
    )
    tiered_rule["maintenance_tiers"] = [
        {
            "notional_cap": "500",
            "maintenance_rate": "0.005",
            "maintenance_deduction": "0",
        },
        {
            "notional_cap": "100000",
            "maintenance_rate": "0.01",
            "maintenance_deduction": "2.5",
        },
    ]
    build_account_history_archive(
        source,
        archive_id="decimal-golden",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
        funding_interval_ms=0,
        rule_changes=(tiered_rule,),
        price_at=lambda _timestamp: "100",
    )
    service = await _service(database)
    try:
        base = await _base_request(service)
        exact, _ = await _import_and_plan(
            service,
            source,
            _exact_request(base, funding=False),
        )
        created = await service.training.create_run(exact)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="decimal-golden-acquire",
        )
        opened = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="decimal-golden-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "decimal-golden-open",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        portfolio = opened["data"]["portfolio"]
        assert portfolio["positions"][0]["position"]["notional"] == "1000"
        assert portfolio["margin_used"] == "500"
        assert portfolio["maintenance_margin"] == "7.5"
        closed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="decimal-golden-partial-close",
            command_type=ReplayV2CommandType.CLOSE_POSITION,
            payload={"quantity": "0.6"},
        )
        assert (
            closed["data"]["portfolio"]["positions"][0]["position"]["quantity"] == "0.4"
        )
        assert closed["data"]["portfolio"]["margin_used"] == "200"
        assert closed["data"]["portfolio"]["maintenance_margin"] == "2"
        before_finalize = closed["data"]["portfolio"]
        assert service.training is not None
        await service.training.store.finalize_account_history(run_id)
        await service.training.store.finalize_account_history(run_id)
        after_finalize = await service.training.get_market_tracks(run_id)
        assert after_finalize["portfolio"]["positions"] == before_finalize["positions"]
        assert (
            after_finalize["portfolio"]["cash_balance"]
            == before_finalize["cash_balance"]
        )
        with sqlite3.connect(database) as connection:
            fills = connection.execute(
                """
                SELECT fill_json, rule_revision, configured_fee, fee_fidelity
                FROM replay_training_contract_fill
                WHERE run_id = ? ORDER BY fill_id
                """,
                (run_id,),
            ).fetchall()
        assert len(fills) == 2
        decoded = [json.loads(row[0]) for row in fills]
        assert {fill["contract_size"] for fill in decoded} == {"10"}
        assert {fill["liquidity"] for fill in decoded} == {"TAKER"}
        assert [row[1] for row in fills] == [1, 1]
        assert sorted(row[2] for row in fills) == ["0.32", "0.52"]
        assert {row[3] for row in fills} == {"CONFIGURED_POLICY_EXACT"}
        audit = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert audit["status"] == "PASS"
        assert audit["differences"] == []
    finally:
        await service.shutdown(step_timeout=1.0)
