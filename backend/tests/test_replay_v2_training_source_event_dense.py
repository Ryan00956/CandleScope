from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import replace
from hashlib import sha256
from pathlib import Path

import pytest

from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeDay,
)
from app.replay.service import ReplayService
from app.replay.constants import CommandType, REPLAY_PROTOCOL
from app.replay.models import ReplayCommand
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.commands import ReplayV2Command
from app.replay.training.errors import TrainingRunError
from app.replay.training.hedge_inputs import (
    build_hedge_public_history_archive,
    build_hedge_simulation_manifest,
)
from app.replay.training.models import (
    HEDGE_ACCOUNT_FIDELITY,
    HEDGE_INSURANCE_ADL_FIDELITY,
    ReplayV2CommandType,
    TrainingCursor,
    TrainingRunCreateRequest,
)
from tests.fixtures.replay.fakes import FakeKlinesRepo, FixtureIdentity
from tests.fixtures.replay.service_fakes import SessionIdFactory, replay_settings
from tests.fixtures.replay.trade_service_fakes import (
    INTERVAL_MS,
    TRADE_NOW_MS,
    TRADE_REPLAY_MINUTES,
    TRADE_REPLAY_START_MS,
)


pytestmark = pytest.mark.anyio

DENSE_EVENT_TIME_MS = TRADE_REPLAY_START_MS + 1_000
TAIL_EVENT_TIME_MS = TRADE_REPLAY_START_MS + INTERVAL_MS + 1_000


def _dense_trade_sources(
    root: Path,
    *,
    dense_count: int,
) -> tuple[FakeKlinesRepo, ParquetRawAggTradeArchive]:
    identity = FixtureIdentity("binance", "futures", "BTCUSDT")
    rows: list[dict[str, object]] = []
    for minute in range(-2, TRADE_REPLAY_MINUTES + 2):
        open_ms = TRADE_REPLAY_START_MS + minute * INTERVAL_MS
        if minute == 0:
            price = 100
            volume = dense_count
            trades = dense_count
            taker_buy_base = dense_count // 2
        elif minute == 1:
            price = 101
            volume = 1
            trades = 1
            taker_buy_base = 1
        else:
            price = 100 + minute
            volume = 0
            trades = 0
            taker_buy_base = 0
        rows.append(
            {
                "open_time": open_ms,
                "close_time": open_ms + INTERVAL_MS - 1,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": volume,
                "quote_volume": price * volume,
                "trades": trades,
                "taker_buy_base": taker_buy_base,
                "taker_buy_quote": price * taker_buy_base,
                "source": "verified_dense_fixture",
            }
        )
    repository = FakeKlinesRepo()
    repository.add_rows(identity, "1m", rows)

    archive = ParquetRawAggTradeArchive(
        root,
        max_rows_per_file=512,
        max_scan_rows=100_000,
        max_physical_scan_rows=100_000,
    )
    first_agg_trade_id = 800_000
    trades_payload: list[dict[str, object]] = []
    for index in range(dense_count):
        trades_payload.append(
            {
                "exchange": "binance",
                "market_type": "futures",
                "symbol": "BTCUSDT",
                "agg_trade_id": first_agg_trade_id + index,
                "first_trade_id": 8_000_000 + index,
                "last_trade_id": 8_000_000 + index,
                "price": 100,
                "quantity": 1,
                "quote_quantity": 100,
                "trade_time_ms": DENSE_EVENT_TIME_MS,
                "event_time_ms": DENSE_EVENT_TIME_MS,
                "received_at_ms": DENSE_EVENT_TIME_MS,
                "is_buyer_maker": index % 2 == 0,
                "source": "binance_public",
            }
        )
    tail_index = dense_count
    trades_payload.append(
        {
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
            "agg_trade_id": first_agg_trade_id + tail_index,
            "first_trade_id": 8_000_000 + tail_index,
            "last_trade_id": 8_000_000 + tail_index,
            "price": 101,
            "quantity": 1,
            "quote_quantity": 101,
            "trade_time_ms": TAIL_EVENT_TIME_MS,
            "event_time_ms": TAIL_EVENT_TIME_MS,
            "received_at_ms": TAIL_EVENT_TIME_MS,
            "is_buyer_maker": False,
            "source": "binance_public",
        }
    )
    metadata = VerifiedRawAggTradeDay(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        date="2026-06-01",
        source_url="https://data.binance.vision/BTCUSDT-dense-fixture.zip",
        source_file="BTCUSDT-dense-fixture.zip",
        source_checksum_sha256=sha256(
            f"dense-source-event:{dense_count}".encode("utf-8")
        ).hexdigest(),
        row_count=len(trades_payload),
        first_agg_trade_id=first_agg_trade_id,
        last_agg_trade_id=first_agg_trade_id + len(trades_payload) - 1,
        first_trade_time_ms=DENSE_EVENT_TIME_MS,
        last_trade_time_ms=TAIL_EVENT_TIME_MS,
    )
    archive.import_verified_day(trades_payload, metadata)
    return repository, archive


async def _dense_service(
    database: Path,
    archive_root: Path,
    *,
    dense_count: int,
    event_buffer_size: int = 256,
) -> ReplayService:
    repository, archive = _dense_trade_sources(
        archive_root,
        dense_count=dense_count,
    )
    settings = replay_settings(database)
    service = ReplayService(
        settings=replace(
            settings,
            event_buffer_size=event_buffer_size,
            trade_page_rows=512,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: TRADE_NOW_MS),
        repository=repository,
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("dense-adapter"),
        training_run_id_factory=SessionIdFactory("dense-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _asymmetric_dense_service(
    database: Path,
    archive_root: Path,
) -> ReplayService:
    repository, archive = _dense_trade_sources(archive_root, dense_count=2)
    identity = FixtureIdentity("binance", "futures", "ETHUSDT")
    rows: list[dict[str, object]] = []
    for minute in range(-2, TRADE_REPLAY_MINUTES + 2):
        open_ms = TRADE_REPLAY_START_MS + minute * INTERVAL_MS
        price = 200 + minute
        active = minute in {0, 1}
        rows.append(
            {
                "open_time": open_ms,
                "close_time": open_ms + INTERVAL_MS - 1,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": 1 if active else 0,
                "quote_volume": price if active else 0,
                "trades": 1 if active else 0,
                "taker_buy_base": 1 if active else 0,
                "taker_buy_quote": price if active else 0,
                "source": "verified_asymmetric_fixture",
            }
        )
    repository.add_rows(identity, "1m", rows)
    first_agg_trade_id = 900_000
    trades = [
        {
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "ETHUSDT",
            "agg_trade_id": first_agg_trade_id + index,
            "first_trade_id": 9_000_000 + index,
            "last_trade_id": 9_000_000 + index,
            "price": price,
            "quantity": 1,
            "quote_quantity": price,
            "trade_time_ms": event_time,
            "event_time_ms": event_time,
            "received_at_ms": event_time,
            "is_buyer_maker": False,
            "source": "binance_public",
        }
        for index, (price, event_time) in enumerate(
            ((200, DENSE_EVENT_TIME_MS), (201, TAIL_EVENT_TIME_MS))
        )
    ]
    archive.import_verified_day(
        trades,
        VerifiedRawAggTradeDay(
            exchange="binance",
            market_type="futures",
            symbol="ETHUSDT",
            date="2026-06-01",
            source_url="https://data.binance.vision/ETHUSDT-asymmetric-fixture.zip",
            source_file="ETHUSDT-asymmetric-fixture.zip",
            source_checksum_sha256=sha256(b"asymmetric-dense-eth").hexdigest(),
            row_count=len(trades),
            first_agg_trade_id=first_agg_trade_id,
            last_agg_trade_id=first_agg_trade_id + len(trades) - 1,
            first_trade_time_ms=DENSE_EVENT_TIME_MS,
            last_trade_time_ms=TAIL_EVENT_TIME_MS,
        ),
    )
    settings = replay_settings(database)
    service = ReplayService(
        settings=replace(settings, event_buffer_size=256, trade_page_rows=512),
        store=ReplaySQLiteStore(database, now_ms=lambda: TRADE_NOW_MS),
        repository=repository,
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("asymmetric-adapter"),
        training_run_id_factory=SessionIdFactory("asymmetric-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _base_request(service: ReplayService) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=TRADE_REPLAY_MINUTES * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=False,
        source_kind="AGG_TRADE",
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v3",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Dense same-millisecond SOURCE_EVENT",
            "source_kind": "AGG_TRADE",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": TRADE_REPLAY_START_MS,
            "warmup_bars": 2,
            "forward_cache_ms": TRADE_REPLAY_MINUTES * INTERVAL_MS,
            "random_seed": 17,
            "initial_equity": "10000",
            "max_leverage": "3",
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


async def _prepare_dense_hedge_request(
    service: ReplayService,
    request: TrainingRunCreateRequest,
    *,
    root: Path,
) -> TrainingRunCreateRequest:
    assert service.training is not None
    start = request.requested_start_ms
    assert start is not None
    end = start + request.forward_cache_ms
    rule = {
        "rule_version": "BINANCE_USDM_LINEAR_V1",
        "price_tick": "0.1",
        "quantity_step": "0.001",
        "min_quantity": "0.001",
        "max_quantity": "1000",
        "min_notional": "5",
        "max_notional": "1000000",
        "quote_step": "0.01",
        "contract_size": "1",
        "max_leverage": "20",
        "liquidation_fee_bps": "25",
        "maintenance_tiers": [
            {
                "notional_cap": "50000",
                "maintenance_rate": "0.005",
                "maintenance_deduction": "0",
            },
            {
                "notional_cap": "1000000",
                "maintenance_rate": "0.01",
                "maintenance_deduction": "250",
            },
        ],
    }
    fee = {
        "policy_version": "BINANCE_VIP0_V1",
        "account_tier": "VIP0",
        "maker_fee_bps": "2",
        "taker_fee_bps": "5",
        "liquidation_fee_bps": "25",
    }
    public_events: list[dict[str, object]] = [
        {"event_time_ms": start, "event_kind": "RULE", "payload": rule},
        {"event_time_ms": start, "event_kind": "FEE_POLICY", "payload": fee},
        {
            "event_time_ms": start,
            "event_kind": "MARK_INDEX",
            "payload": {"mark_price": "100", "index_price": "100"},
        },
        {
            "event_time_ms": DENSE_EVENT_TIME_MS,
            "event_kind": "MARK_INDEX",
            "payload": {"mark_price": "101", "index_price": "101"},
        },
        {
            "event_time_ms": DENSE_EVENT_TIME_MS,
            "event_kind": "FUNDING",
            "payload": {"funding_rate": "0.0001", "mark_price": "101"},
        },
    ]
    public_events.extend(
        {
            "event_time_ms": start + minute * INTERVAL_MS,
            "event_kind": "MARK_INDEX",
            "payload": {
                "mark_price": str(101 + minute),
                "index_price": str(101 + minute),
            },
        }
        for minute in range(1, TRADE_REPLAY_MINUTES + 1)
    )
    public_events.sort(
        key=lambda item: (
            int(item["event_time_ms"]),
            {"RULE": 10, "FEE_POLICY": 10, "MARK_INDEX": 30, "FUNDING": 40}[
                str(item["event_kind"])
            ],
            str(item["event_kind"]),
        )
    )
    public_path = root / "dense-public.json"
    public_ref = build_hedge_public_history_archive(
        public_path,
        archive_id="dense-public",
        exchange=request.exchange,
        market_type=request.market_type,
        symbol=request.symbol,
        settlement_asset=request.settlement_asset,
        range_start_ms=start,
        range_end_ms=end,
        max_mark_gap_ms=INTERVAL_MS,
        source_identity="TEST_PINNED_PUBLIC_CAPTURE",
        capture_receipt="receipt:dense-source-event",
        historical_l2_ref=None,
        events=public_events,
    )
    simulation_path = root / "dense-simulation.json"
    simulation_ref = build_hedge_simulation_manifest(
        simulation_path,
        manifest_id="dense-simulation",
        range_start_ms=start,
        range_end_ms=end,
        settlement_asset=request.settlement_asset,
        required_symbols=[request.symbol],
        insurance_events=[
            {
                "effective_time_ms": start,
                "kind": "OPENING_BALANCE",
                "amount": "1000000",
            },
            {
                "effective_time_ms": DENSE_EVENT_TIME_MS,
                "kind": "CREDIT",
                "amount": "1",
            },
        ],
        adl_snapshots=[
            {
                "symbol": request.symbol,
                "effective_time_ms": start,
                "valid_until_ms": end,
                "candidates": [
                    {
                        "candidate_id": "dense-short-start",
                        "symbol": request.symbol,
                        "position_side": "SHORT",
                        "quantity": "1",
                        "entry_price": "110",
                        "mark_price": "100",
                        "initial_margin": "5",
                        "margin_balance": "10",
                    }
                ],
            },
            {
                "symbol": request.symbol,
                "effective_time_ms": DENSE_EVENT_TIME_MS,
                "valid_until_ms": end,
                "candidates": [
                    {
                        "candidate_id": "dense-short-cohort",
                        "symbol": request.symbol,
                        "position_side": "SHORT",
                        "quantity": "1",
                        "entry_price": "110",
                        "mark_price": "101",
                        "initial_margin": "5",
                        "margin_balance": "10",
                    }
                ],
            },
        ],
    )
    await service.training.hedge_inputs.import_public(public_path)
    await service.training.hedge_inputs.import_simulation(simulation_path)
    payload = request.to_dict()
    payload.update(
        {
            "position_mode": "HEDGE",
            "account_data_mode": "DETERMINISTIC_SIMULATION",
            "account_history_ref": None,
            "funding_mode": "HISTORICAL_EXACT",
            "fixed_funding_rate": None,
            "funding_interval_ms": None,
            "hedge_public_history_ref": {
                "schema_version": "replay.hedge-public-history-ref.v1",
                **public_ref,
            },
            "simulation_manifest_ref": {
                "schema_version": "replay.hedge-simulation-manifest-ref.v1",
                **simulation_ref,
            },
            "account_fidelity": HEDGE_ACCOUNT_FIDELITY,
            "insurance_adl_fidelity": HEDGE_INSURANCE_ADL_FIDELITY,
        }
    )
    return TrainingRunCreateRequest.from_dict(payload)


def _command(
    run_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    session: dict[str, object],
    payload: dict[str, object],
) -> ReplayV2Command:
    snapshot = session["snapshot"]
    assert isinstance(snapshot, dict)
    cursor = snapshot["cursor"]
    assert isinstance(cursor, dict)
    revision = int(snapshot["revision"])
    return ReplayV2Command(
        protocol="replay.v3",
        run_id=run_id,
        command_id=command_id,
        client_instance_id="dense-source-event-browser",
        expected_revision=revision,
        expected_cursor=TrainingCursor(
            virtual_time_ms=int(cursor["virtual_time_ms"]),
            source_sequence=int(cursor["source_sequence"]),
            revision=revision,
        ),
        type=command_type,
        payload=payload,
    )


async def _send(
    service: ReplayService,
    *,
    run_id: str,
    session_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    payload: dict[str, object],
) -> dict[str, object]:
    assert service.training is not None
    session = await service.get_session(session_id)
    return await service.training.command(
        run_id,
        _command(run_id, command_id, command_type, session, payload),
    )


async def _create_run(
    service: ReplayService,
    *,
    root: Path,
) -> tuple[str, str]:
    assert service.training is not None
    request = await _prepare_dense_hedge_request(
        service,
        await _base_request(service),
        root=root,
    )
    return await _create_and_acquire(service, request)


async def _create_and_acquire(
    service: ReplayService,
    request: TrainingRunCreateRequest,
) -> tuple[str, str]:
    assert service.training is not None
    created = await service.training.create_run(request)
    run_id = str(created["run"]["run_id"])
    session_id = str(created["run"]["adapter_session_id"])
    await _send(
        service,
        run_id=run_id,
        session_id=session_id,
        command_id="dense-acquire",
        command_type=ReplayV2CommandType.ACQUIRE_CONTROLLER,
        payload={"takeover": False},
    )
    return run_id, session_id


def _input_cursors(database: Path, run_id: str) -> dict[str, int]:
    with sqlite3.connect(database) as connection:
        return {
            str(source_kind): int(sequence)
            for source_kind, sequence in connection.execute(
                """
                SELECT source_kind, last_event_sequence
                FROM replay_hedge_input_projection
                WHERE run_id = ? ORDER BY source_kind
                """,
                (run_id,),
            ).fetchall()
        }


async def _dense_time_events(
    service: ReplayService,
    run_id: str,
) -> list[dict[str, object]]:
    assert service.training is not None
    return [
        event
        for event in await service.training.store.global_events(run_id)
        if event["actual_event_time_ms"] == DENSE_EVENT_TIME_MS
    ]


async def test_canonical_source_event_advance_matches_step_event_exactly(
    tmp_path: Path,
) -> None:
    database = tmp_path / "canonical-source-event.db"
    service = await _dense_service(
        database,
        tmp_path / "canonical-source-event-trades",
        dense_count=18,
    )
    try:
        request = await _prepare_dense_hedge_request(
            service,
            await _base_request(service),
            root=tmp_path / "canonical-source-event-inputs",
        )
        step_run_id, step_session_id = await _create_and_acquire(service, request)
        advance_run_id, advance_session_id = await _create_and_acquire(
            service,
            request,
        )

        stepped = await _send(
            service,
            run_id=step_run_id,
            session_id=step_session_id,
            command_id="dense-step-alias-one",
            command_type=ReplayV2CommandType.STEP_EVENT,
            payload={"count": 1},
        )
        advanced = await _send(
            service,
            run_id=advance_run_id,
            session_id=advance_session_id,
            command_id="dense-canonical-one",
            command_type=ReplayV2CommandType.ADVANCE,
            payload={"basis": "SOURCE_EVENT", "count": 1},
        )

        for result in (stepped, advanced):
            assert result["cursor"]["source_sequence"] == 1
            assert result["cursor"]["virtual_time_ms"] == DENSE_EVENT_TIME_MS
            assert result["data"]["consumed"] == 1
            assert result["data"]["plan"]["basis"] == "SOURCE_EVENT"
            assert result["data"]["plan"]["count"] == 1
            assert result["data"]["plan"]["mode"] == (
                "GLOBAL_ORDERED_INPUT_CLOCK"
            )

        step_snapshot = (await service.get_session(step_session_id))["snapshot"]
        advance_snapshot = (await service.get_session(advance_session_id))["snapshot"]
        assert advance_snapshot["cursor"] == step_snapshot["cursor"]
        assert advance_snapshot["state_hash"] == step_snapshot["state_hash"]
        assert _input_cursors(database, advance_run_id) == _input_cursors(
            database,
            step_run_id,
        )

        assert service.training is not None
        step_events = await service.training.store.global_events(step_run_id)
        advance_events = await service.training.store.global_events(advance_run_id)

        def comparable_events(
            events: list[dict[str, object]],
        ) -> list[tuple[int, int, int]]:
            return [
                (
                    int(event["actual_event_time_ms"]),
                    int(event["event_phase"]),
                    int(event["source_sequence"]),
                )
                for event in events
            ]

        assert comparable_events(advance_events) == comparable_events(step_events)
        advance_market = [
            event for event in advance_events if event["event_phase"] == 20
        ]
        assert comparable_events(advance_market) == [
            (DENSE_EVENT_TIME_MS, 20, 1)
        ]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_source_event_overrun_fails_before_any_mutation(
    tmp_path: Path,
) -> None:
    database = tmp_path / "source-event-overrun.db"
    service = await _dense_service(
        database,
        tmp_path / "source-event-overrun-trades",
        dense_count=3,
    )
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / "source-event-overrun-inputs",
        )
        assert service.training is not None
        before = await service.get_session(session_id)
        before_events = await service.training.store.global_events(run_id)
        before_inputs = _input_cursors(database, run_id)

        with pytest.raises(TrainingRunError) as exc_info:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="dense-canonical-overrun",
                command_type=ReplayV2CommandType.ADVANCE,
                payload={"basis": "SOURCE_EVENT", "count": 5},
            )
        error = exc_info.value
        assert error.code == "REPLAY_CONTROL_UNAVAILABLE"
        assert error.status_code == 409
        assert dict(error.details) == {
            "requested_count": 5,
            "available_count": 4,
        }

        after = await service.get_session(session_id)
        assert after["snapshot"] == before["snapshot"]
        assert await service.training.store.global_events(run_id) == before_events
        assert _input_cursors(database, run_id) == before_inputs
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize(
    ("command_type", "payload"),
    (
        (ReplayV2CommandType.STEP_EVENT, {"count": 128}),
        (
            ReplayV2CommandType.ADVANCE,
            {"basis": "SOURCE_EVENT", "count": 128},
        ),
    ),
)
async def test_source_event_preflight_pages_beyond_event_buffer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    command_type: ReplayV2CommandType,
    payload: dict[str, object],
) -> None:
    service = await _dense_service(
        tmp_path / f"paged-{command_type.value}.db",
        tmp_path / f"paged-{command_type.value}-trades",
        dense_count=300,
        event_buffer_size=1,
    )
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / f"paged-{command_type.value}-inputs",
        )
        before = await service.get_session(session_id)
        original_scan = service.scan_source_goal
        goal_scan_calls = 0

        async def counting_scan_source_goal(
            scan_session_id: str,
            *,
            max_events: int,
        ) -> dict[str, object]:
            nonlocal goal_scan_calls
            goal_scan_calls += 1
            return await original_scan(
                scan_session_id,
                max_events=max_events,
            )

        monkeypatch.setattr(service, "scan_source_goal", counting_scan_source_goal)
        result = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"paged-{command_type.value}",
            command_type=command_type,
            payload=payload,
        )
        requested_count = int(payload["count"])
        assert result["data"]["consumed"] == requested_count
        assert goal_scan_calls == 1
        assert result["cursor"]["source_sequence"] == requested_count
        assert int(result["revision"]) > int(before["snapshot"]["revision"])

        assert service.training is not None
        market = [
            event
            for event in await service.training.store.global_events(run_id)
            if event["event_phase"] == 20
        ]
        assert [event["source_sequence"] for event in market] == list(
            range(1, requested_count + 1)
        )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_paged_source_event_overrun_still_fails_before_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "paged-overrun.db"
    service = await _dense_service(
        database,
        tmp_path / "paged-overrun-trades",
        dense_count=300,
        event_buffer_size=1,
    )
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / "paged-overrun-inputs",
        )
        assert service.training is not None
        before = await service.get_session(session_id)
        before_events = await service.training.store.global_events(run_id)
        before_inputs = _input_cursors(database, run_id)
        original_scan = service.scan_source_goal
        goal_scan_calls = 0

        async def counting_scan_source_goal(
            scan_session_id: str,
            *,
            max_events: int,
        ) -> dict[str, object]:
            nonlocal goal_scan_calls
            goal_scan_calls += 1
            return await original_scan(
                scan_session_id,
                max_events=max_events,
            )

        monkeypatch.setattr(service, "scan_source_goal", counting_scan_source_goal)

        with pytest.raises(TrainingRunError) as exc_info:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="paged-overrun",
                command_type=ReplayV2CommandType.STEP_EVENT,
                payload={"count": 129},
            )
        assert exc_info.value.code == "REPLAY_CONTROL_INVALID"
        assert dict(exc_info.value.details) == {
            "basis": "SOURCE_EVENT",
            "requested_count": 129,
            "max_count": 128,
        }
        assert goal_scan_calls == 0
        assert (await service.get_session(session_id))["snapshot"] == before["snapshot"]
        assert await service.training.store.global_events(run_id) == before_events
        assert _input_cursors(database, run_id) == before_inputs
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_cancelled_source_goal_scan_keeps_actor_responsive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _dense_service(
        tmp_path / "cancelled-goal.db",
        tmp_path / "cancelled-goal-trades",
        dense_count=300,
        event_buffer_size=1,
    )
    try:
        _run_id, session_id = await _create_run(
            service,
            root=tmp_path / "cancelled-goal-inputs",
        )
        actor = service._sessions[session_id].actor
        original_scan = actor._scan_source_goal
        entered = asyncio.Event()
        release = asyncio.Event()

        async def held_scan_source_goal(
            *,
            max_events: int,
            cancelled: object = None,
        ) -> dict[str, object]:
            entered.set()
            await release.wait()
            return await original_scan(
                max_events=max_events,
                cancelled=cancelled,  # type: ignore[arg-type]
            )

        monkeypatch.setattr(actor, "_scan_source_goal", held_scan_source_goal)
        scan = asyncio.create_task(
            service.scan_source_goal(session_id, max_events=100_000)
        )
        await asyncio.wait_for(entered.wait(), timeout=1.0)
        scan.cancel()
        with pytest.raises(asyncio.CancelledError):
            await scan
        release.set()

        snapshot = await asyncio.wait_for(service.get_session(session_id), timeout=1.0)
        assert snapshot["snapshot"]["state"] == "PAUSED"
        assert snapshot["snapshot"]["degraded_reason"] is None
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_source_goal_rejects_adapter_mutation_after_scan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _dense_service(
        tmp_path / "goal-race.db",
        tmp_path / "goal-race-trades",
        dense_count=10,
    )
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / "goal-race-inputs",
        )
        assert service.training is not None
        before = await service.get_session(session_id)
        before_events = await service.training.store.global_events(run_id)
        original_scan = service.scan_source_goal

        async def mutate_after_scan(
            scan_session_id: str,
            *,
            max_events: int,
        ) -> dict[str, object]:
            plan = await original_scan(scan_session_id, max_events=max_events)
            snapshot = (await service.get_session(scan_session_id))["snapshot"]
            await service.command(
                scan_session_id,
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id="goal-race-release-mutation",
                    client_instance_id="dense-source-event-browser",
                    expected_revision=int(snapshot["revision"]),
                    type=CommandType.RELEASE_CONTROLLER,
                    payload={},
                ),
            )
            return plan

        monkeypatch.setattr(service, "scan_source_goal", mutate_after_scan)
        with pytest.raises(TrainingRunError) as exc_info:
            await service.training.command(
                run_id,
                _command(
                    run_id,
                    "goal-race-v2",
                    ReplayV2CommandType.STEP_EVENT,
                    before,
                    {"count": 1},
                ),
            )
        assert exc_info.value.code == "GLOBAL_CLOCK_DIVERGED"
        after = await service.get_session(session_id)
        assert after["snapshot"]["cursor"] == before["snapshot"]["cursor"]
        assert await service.training.store.global_events(run_id) == before_events
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_ordered_source_event_counts_are_exact_inside_one_dense_cohort(
    tmp_path: Path,
) -> None:
    database = tmp_path / "exact-counts.db"
    service = await _dense_service(
        database,
        tmp_path / "exact-counts-trades",
        dense_count=200,
    )
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / "exact-counts-inputs",
        )
        cumulative = 0
        for count in (1, 17, 128):
            before = await service.get_session(session_id)
            before_sequence = int(before["snapshot"]["cursor"]["source_sequence"])
            result = await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"dense-step-{count}",
                command_type=ReplayV2CommandType.STEP_EVENT,
                payload={"count": count},
            )
            after_sequence = int(result["cursor"]["source_sequence"])
            assert after_sequence - before_sequence == count
            cumulative += count

            events = await _dense_time_events(service, run_id)
            market = [event for event in events if event["event_phase"] == 20]
            assert [event["source_sequence"] for event in market] == list(
                range(1, cumulative + 1)
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_dense_cohort_defers_post_market_inputs_until_the_cohort_closes(
    tmp_path: Path,
) -> None:
    database = tmp_path / "cohort-phases.db"
    archive_root = tmp_path / "cohort-phases-trades"
    service = await _dense_service(
        database,
        archive_root,
        dense_count=18,
    )
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / "cohort-phases-inputs",
        )
        initial_inputs = _input_cursors(database, run_id)

        partial = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="dense-partial-seventeen",
            command_type=ReplayV2CommandType.STEP_EVENT,
            payload={"count": 17},
        )
        assert partial["cursor"]["source_sequence"] == 17
        partial_events = await _dense_time_events(service, run_id)
        assert [event["event_phase"] for event in partial_events] == [20] * 17
        assert _input_cursors(database, run_id) == initial_inputs

        await service.shutdown(step_timeout=1.0)
        service = await _dense_service(
            database,
            archive_root,
            dense_count=18,
        )
        restored = await service.get_session(session_id)
        assert restored["snapshot"]["cursor"] == partial["cursor"]
        restored_events = await _dense_time_events(service, run_id)
        assert restored_events == partial_events
        assert _input_cursors(database, run_id) == initial_inputs

        closed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="dense-close-cohort",
            command_type=ReplayV2CommandType.STEP_EVENT,
            payload={"count": 1},
        )
        assert closed["cursor"]["source_sequence"] == 18
        closed_events = await _dense_time_events(service, run_id)
        assert [event["event_phase"] for event in closed_events] == [
            *([20] * 18),
            30,
            40,
            70,
            70,
        ]
        ordering_keys = [
            (
                int(event["actual_event_time_ms"]),
                int(event["event_phase"]),
                str(event["track_id"]),
                int(event["source_sequence"]),
            )
            for event in closed_events
        ]
        assert ordering_keys == sorted(ordering_keys)
        final_inputs = _input_cursors(database, run_id)
        assert final_inputs == {
            "PUBLIC": initial_inputs["PUBLIC"] + 2,
            "SIMULATION": initial_inputs["SIMULATION"] + 2,
        }
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_dense_source_event_playback_never_commits_an_empty_due_batch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "continuous-playback.db"
    service = await _dense_service(
        database,
        tmp_path / "continuous-playback-trades",
        dense_count=300,
    )
    run_id: str | None = None
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / "continuous-playback-inputs",
        )
        before = await service.get_session(session_id)
        before_sequence = int(before["snapshot"]["cursor"]["source_sequence"])
        two_batches_finished = asyncio.Event()
        scheduler_calls = 0

        def two_due_batches(_elapsed_seconds: object, *, rate: int) -> int:
            nonlocal scheduler_calls
            assert rate == 10_000
            scheduler_calls += 1
            if scheduler_calls <= 2:
                return 128
            two_batches_finished.set()
            return 0

        monkeypatch.setattr(
            "app.replay.training.service.discrete_playback_units",
            two_due_batches,
        )
        playing = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="dense-play",
            command_type=ReplayV2CommandType.PLAY,
            payload={"basis": "SOURCE_EVENT", "rate": 10_000},
        )
        assert playing["state"] == "PLAYING"
        await asyncio.wait_for(two_batches_finished.wait(), timeout=5.0)
        paused = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="dense-pause",
            command_type=ReplayV2CommandType.PAUSE,
            payload={},
        )
        assert paused["state"] == "PAUSED"
        assert scheduler_calls >= 3

        after = await service.get_session(session_id)
        after_sequence = int(after["snapshot"]["cursor"]["source_sequence"])
        assert after_sequence - before_sequence == 256
        assert after["snapshot"]["cursor"]["virtual_time_ms"] == DENSE_EVENT_TIME_MS
        events = await _dense_time_events(service, run_id)
        market = [event for event in events if event["event_phase"] == 20]
        assert [event["source_sequence"] for event in market] == list(range(1, 257))

        stable_cursor = dict(after["snapshot"]["cursor"])
        await asyncio.sleep(0.02)
        reread = await service.get_session(session_id)
        assert reread["snapshot"]["cursor"] == stable_cursor
    finally:
        if run_id is not None and service.training is not None:
            actor = service.training._run_actors.get(run_id)
            if actor is not None:
                task = actor.request_ordered_pause(reason="TEST_CLEANUP")
                if task is not None:
                    await asyncio.gather(task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize(
    ("command_type", "payload"),
    (
        (ReplayV2CommandType.STEP_BASE, {"count": 1}),
        (
            ReplayV2CommandType.ADVANCE,
            {"basis": "VIRTUAL_TIME", "duration_ms": INTERVAL_MS},
        ),
        (
            ReplayV2CommandType.ADVANCE_TO,
            {"virtual_time_ms": TRADE_REPLAY_START_MS + INTERVAL_MS},
        ),
        (
            ReplayV2CommandType.STEP_DISPLAY,
            {
                "count": 1,
                "display_interval": "1m",
                "viewer_revision": 0,
            },
        ),
    ),
)
async def test_partial_dense_cohort_closes_before_switching_advance_basis(
    tmp_path: Path,
    command_type: ReplayV2CommandType,
    payload: dict[str, object],
) -> None:
    database = tmp_path / f"switch-{command_type.value}.db"
    archive_root = tmp_path / f"switch-{command_type.value}-trades"
    service = await _dense_service(database, archive_root, dense_count=18)
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / f"switch-{command_type.value}-inputs",
        )
        partial = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"switch-{command_type.value}-partial",
            command_type=ReplayV2CommandType.STEP_EVENT,
            payload={"count": 17},
        )
        assert partial["cursor"]["source_sequence"] == 17
        assert [
            event["event_phase"]
            for event in await _dense_time_events(service, run_id)
        ] == [20] * 17

        await service.shutdown(step_timeout=1.0)
        service = await _dense_service(database, archive_root, dense_count=18)
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"switch-{command_type.value}-advance",
            command_type=command_type,
            payload=payload,
        )
        dense_events = await _dense_time_events(service, run_id)
        assert [event["event_phase"] for event in dense_events] == [
            *([20] * 18),
            30,
            40,
            70,
            70,
        ]
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize(
    ("command_type", "payload"),
    (
        (ReplayV2CommandType.STEP_EVENT, {"count": 4}),
        (
            ReplayV2CommandType.ADVANCE,
            {"basis": "SOURCE_EVENT", "count": 4},
        ),
    ),
)
async def test_exact_source_event_boundary_accepts_terminal_cursor_overshoot(
    tmp_path: Path,
    command_type: ReplayV2CommandType,
    payload: dict[str, object],
) -> None:
    service = await _dense_service(
        tmp_path / f"terminal-{command_type.value}.db",
        tmp_path / f"terminal-{command_type.value}-trades",
        dense_count=3,
    )
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / f"terminal-{command_type.value}-inputs",
        )
        result = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"terminal-{command_type.value}",
            command_type=command_type,
            payload=payload,
        )
        assert result["cursor"]["source_sequence"] == 4
        assert result["cursor"]["at_end"] is True
        assert result["data"]["consumed"] == 4
        session = await service.get_session(session_id)
        assert session["snapshot"]["state"] == "ENDED"
        assert session["snapshot"]["degraded_reason"] is None
        market = [
            event
            for event in await service.training.store.global_events(run_id)  # type: ignore[union-attr]
            if event["event_phase"] == 20
        ]
        assert [event["source_sequence"] for event in market] == [1, 2, 3, 4]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_source_event_playback_finishes_as_source_exhausted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _dense_service(
        tmp_path / "terminal-play.db",
        tmp_path / "terminal-play-trades",
        dense_count=3,
    )
    run_id: str | None = None
    try:
        run_id, session_id = await _create_run(
            service,
            root=tmp_path / "terminal-play-inputs",
        )
        monkeypatch.setattr(
            "app.replay.training.service.discrete_playback_units",
            lambda _elapsed_seconds, *, rate: 128,
        )
        playing = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="terminal-play",
            command_type=ReplayV2CommandType.PLAY,
            payload={"basis": "SOURCE_EVENT", "rate": 10_000},
        )
        assert playing["state"] == "PLAYING"

        assert service.training is not None
        for _attempt in range(100):
            projection = await service.training.get_market_tracks(run_id)
            if projection["global_clock"]["state"] == "ENDED":
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail(
                "SOURCE_EVENT playback did not reach its terminal clock: "
                f"{projection['global_clock']}"
            )

        assert projection["global_clock"] == {
            **projection["global_clock"],
            "state": "ENDED",
            "reason": "SOURCE_EXHAUSTED",
        }
        terminal = await service.get_session(session_id)
        assert terminal["snapshot"]["cursor"]["source_sequence"] == 4
        assert terminal["snapshot"]["cursor"]["at_end"] is True
        assert terminal["snapshot"]["state"] == "ENDED"
    finally:
        if run_id is not None and service.training is not None:
            actor = service.training._run_actors.get(run_id)
            if actor is not None:
                task = actor.request_ordered_pause(reason="TEST_CLEANUP")
                if task is not None:
                    await asyncio.gather(task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)


async def test_multitrack_asymmetric_same_time_cohort_is_globally_ordered(
    tmp_path: Path,
) -> None:
    service = await _asymmetric_dense_service(
        tmp_path / "asymmetric-multitrack.db",
        tmp_path / "asymmetric-multitrack-trades",
    )
    try:
        assert service.training is not None
        created = await service.training.create_run(await _base_request(service))
        run_id = str(created["run"]["run_id"])
        primary_session_id = str(created["run"]["adapter_session_id"])
        await _send(
            service,
            run_id=run_id,
            session_id=primary_session_id,
            command_id="asymmetric-add-eth",
            command_type=ReplayV2CommandType.ADD_TRACK,
            payload={
                "exchange": "binance",
                "market_type": "futures",
                "symbol": "ETHUSDT",
                "settlement_asset": "USDT",
                "subscription_tier": "FULL",
            },
        )
        await _send(
            service,
            run_id=run_id,
            session_id=primary_session_id,
            command_id="asymmetric-acquire",
            command_type=ReplayV2CommandType.ACQUIRE_CONTROLLER,
            payload={"takeover": False},
        )
        before_events = await service.training.store.global_events(run_id)
        with pytest.raises(TrainingRunError) as exc_info:
            await _send(
                service,
                run_id=run_id,
                session_id=primary_session_id,
                command_id="asymmetric-over-limit",
                command_type=ReplayV2CommandType.STEP_EVENT,
                payload={"count": 129},
            )
        assert exc_info.value.code == "REPLAY_CONTROL_INVALID"
        assert dict(exc_info.value.details) == {
            "basis": "SOURCE_EVENT",
            "requested_count": 129,
            "max_count": 128,
        }
        assert await service.training.store.global_events(run_id) == before_events
        result = await _send(
            service,
            run_id=run_id,
            session_id=primary_session_id,
            command_id="asymmetric-step",
            command_type=ReplayV2CommandType.STEP_EVENT,
            payload={"count": 1},
        )

        expected = [
            (DENSE_EVENT_TIME_MS, 20, "track-1", 1),
            (DENSE_EVENT_TIME_MS, 20, "track-1", 2),
            (DENSE_EVENT_TIME_MS, 20, "track-2", 1),
        ]
        response_keys = [
            (
                int(event["actual_event_time_ms"]),
                int(event["event_phase"]),
                str(event["market_track_stable_id"]),
                int(event["source_sequence"]),
            )
            for event in result["data"]["stable_order"]
        ]
        assert response_keys == expected
        durable_keys = [
            (
                int(event["actual_event_time_ms"]),
                int(event["event_phase"]),
                str(event["track_id"]),
                int(event["source_sequence"]),
            )
            for event in await service.training.store.global_events(run_id)
        ]
        assert durable_keys == expected

        projection = await service.training.get_market_tracks(run_id)
        assert projection["global_clock"]["state"] != "ERROR"
        for track in projection["tracks"]:
            session = await service.get_session(str(track["adapter_session_id"]))
            assert session["snapshot"]["state"] != "DEGRADED"
            assert session["snapshot"]["degraded_reason"] is None
    finally:
        await service.shutdown(step_timeout=1.0)
