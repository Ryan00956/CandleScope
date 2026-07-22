from __future__ import annotations

import asyncio
import json
import os
import random
import sqlite3
import subprocess
import sys
from dataclasses import replace
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeDay,
)
from app.replay.constants import REPLAY_PROTOCOL, CommandType
from app.replay.storage import ReplaySQLiteStore
from app.replay.models import ReplayCommand
from app.replay.training.commands import ReplayV2Command
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import (
    ReplayV2CommandType,
    TrainingCursor,
    TrainingRunCreateRequest,
)
from app.replay.training.multitrack import StableMarketEvent, stable_market_event_order
from tests.fixtures.replay.fakes import FakeKlinesRepo, FixtureIdentity, make_bar
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    ROW_COUNT,
    START_MS,
    SessionIdFactory,
    replay_repository,
    replay_settings,
)
from tests.fixtures.replay.trade_service_fakes import (
    TRADE_NOW_MS,
    TRADE_REPLAY_MINUTES,
    TRADE_REPLAY_START_MS,
)


pytestmark = pytest.mark.anyio


def _multi_repository(*symbols: str):
    repository = replay_repository()
    for offset, symbol in enumerate(symbols, start=1):
        repository.add_rows(
            FixtureIdentity("binance", "spot", symbol),
            "1m",
            [
                make_bar(
                    START_MS + index * INTERVAL_MS,
                    price=str(100 * (offset + 1) + index),
                )
                for index in range(ROW_COUNT)
            ],
        )
    return repository


async def _service(
    path: Path, *, symbols: tuple[str, ...] = ("ETHUSDT",)
) -> ReplayService:
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=_multi_repository(*symbols),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory("run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


def _multi_trade_sources(
    root: Path,
    symbols: tuple[str, ...],
) -> tuple[FakeKlinesRepo, ParquetRawAggTradeArchive]:
    repository = replay_repository()
    archive = ParquetRawAggTradeArchive(
        root,
        max_rows_per_file=3,
        max_scan_rows=100_000,
        max_physical_scan_rows=100_000,
    )
    for symbol_index, symbol in enumerate(symbols):
        price_base = 100 * (symbol_index + 1)
        identity = FixtureIdentity("binance", "futures", symbol)
        bars: list[dict[str, object]] = []
        trades: list[dict[str, object]] = []
        for minute in range(-2, TRADE_REPLAY_MINUTES + 2):
            open_ms = TRADE_REPLAY_START_MS + minute * INTERVAL_MS
            price = price_base + minute
            active = minute >= 0
            bars.append(
                {
                    "open_time": open_ms,
                    "close_time": open_ms + INTERVAL_MS - 1,
                    "open": price,
                    "high": price,
                    "low": price,
                    "close": price,
                    "volume": 2 if active else 0,
                    "quote_volume": price * 2 if active else 0,
                    "trades": 2 if active else 0,
                    "taker_buy_base": 1 if active else 0,
                    "taker_buy_quote": price if active else 0,
                    "source": "verified_fixture",
                }
            )
        repository.add_rows(identity, "1m", bars)
        first_agg_trade_id = (symbol_index + 1) * 100_000
        for minute in range(TRADE_REPLAY_MINUTES):
            price = price_base + minute
            for within in range(2):
                index = minute * 2 + within
                timestamp = (
                    TRADE_REPLAY_START_MS + minute * INTERVAL_MS + 1_000 + within
                )
                trades.append(
                    {
                        "exchange": "binance",
                        "market_type": "futures",
                        "symbol": symbol,
                        "agg_trade_id": first_agg_trade_id + index,
                        "first_trade_id": first_agg_trade_id * 10 + index,
                        "last_trade_id": first_agg_trade_id * 10 + index,
                        "price": price,
                        "quantity": 1,
                        "quote_quantity": price,
                        "trade_time_ms": timestamp,
                        "event_time_ms": timestamp,
                        "received_at_ms": timestamp,
                        "is_buyer_maker": within == 0,
                        "source": "binance_public",
                    }
                )
        metadata = VerifiedRawAggTradeDay(
            exchange="binance",
            market_type="futures",
            symbol=symbol,
            date="2026-06-01",
            source_url=f"https://data.binance.vision/{symbol}.zip",
            source_file=f"{symbol}.zip",
            source_checksum_sha256=sha256(symbol.encode("utf-8")).hexdigest(),
            row_count=len(trades),
            first_agg_trade_id=first_agg_trade_id,
            last_agg_trade_id=first_agg_trade_id + len(trades) - 1,
            first_trade_time_ms=int(trades[0]["trade_time_ms"]),
            last_trade_time_ms=int(trades[-1]["trade_time_ms"]),
        )
        archive.import_verified_day(trades, metadata)
    return repository, archive


async def _trade_service(
    path: Path,
    *,
    archive_root: Path,
    symbols: tuple[str, ...],
) -> ReplayService:
    repository, archive = _multi_trade_sources(archive_root, symbols)
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
        store=ReplaySQLiteStore(path, now_ms=lambda: TRADE_NOW_MS),
        repository=repository,
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("trade-adapter"),
        training_run_id_factory=SessionIdFactory("trade-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _trade_request(service: ReplayService) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=TRADE_REPLAY_MINUTES * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=False,
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 5 AGG multi market",
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
            "random_seed": 7,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "NONE",
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "funding_mode": "OFF",
            "allow_rule_changes": False,
        }
    )


async def _request(service: ReplayService) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=12 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=False,
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 5 multi market",
            "source_kind": "BAR",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": START_MS + 4 * INTERVAL_MS,
            "warmup_bars": 2,
            "forward_cache_ms": 12 * INTERVAL_MS,
            "random_seed": 42,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "NONE",
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "funding_mode": "OFF",
            "allow_rule_changes": False,
        }
    )


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
        protocol="replay.v2",
        run_id=run_id,
        command_id=command_id,
        client_instance_id="phase5-browser",
        expected_revision=revision,
        expected_cursor=TrainingCursor(
            virtual_time_ms=int(cursor["virtual_time_ms"]),
            source_sequence=int(cursor["source_sequence"]),
            revision=revision,
        ),
        type=command_type,
        payload=payload,
    )


async def _add_track(
    service: ReplayService,
    *,
    run_id: str,
    selected_session_id: str,
    symbol: str,
    tier: str,
    command_id: str,
) -> dict[str, object]:
    selected = await service.get_session(selected_session_id)
    return await service.training.command(  # type: ignore[union-attr]
        run_id,
        _command(
            run_id,
            command_id,
            ReplayV2CommandType.ADD_TRACK,
            selected,
            {
                "exchange": "binance",
                "market_type": "spot",
                "symbol": symbol,
                "settlement_asset": "USDT",
                "subscription_tier": tier,
            },
        ),
    )


async def _acquire(
    service: ReplayService,
    *,
    run_id: str,
    selected_session_id: str,
    command_id: str,
) -> dict[str, object]:
    selected = await service.get_session(selected_session_id)
    return await service.training.command(  # type: ignore[union-attr]
        run_id,
        _command(
            run_id,
            command_id,
            ReplayV2CommandType.ACQUIRE_CONTROLLER,
            selected,
            {"takeover": False},
        ),
    )


async def _place_limit(
    service: ReplayService,
    *,
    run_id: str,
    selected_session_id: str,
    command_id: str,
    client_order_id: str,
    quantity: str,
    limit_price: str,
) -> dict[str, object]:
    selected = await service.get_session(selected_session_id)
    return await service.training.command(  # type: ignore[union-attr]
        run_id,
        _command(
            run_id,
            command_id,
            ReplayV2CommandType.PLACE_ORDER,
            selected,
            {
                "client_order_id": client_order_id,
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": quantity,
                "reduce_only": False,
                "limit_price": limit_price,
                "stop_price": None,
            },
        ),
    )


@pytest.mark.parametrize("track_count", (1, 2, 4, 8))
def test_stable_market_event_order_is_input_order_independent(track_count: int) -> None:
    events = [
        StableMarketEvent(
            actual_event_time_ms=START_MS + (index % 2) * INTERVAL_MS,
            event_phase=20,
            market_track_stable_id=f"track-{index + 1:02d}",
            source_sequence=(index // 2) + 1,
        )
        for index in range(track_count)
    ]
    expected = stable_market_event_order(events)
    shuffled = list(events)
    random.Random(42).shuffle(shuffled)
    assert stable_market_event_order(shuffled) == expected
    assert list(expected) == sorted(events, key=lambda event: event.ordering_key)


def test_global_ordering_hash_is_cross_process_and_hash_seed_stable() -> None:
    program = """
import json
from app.replay.training.multitrack import StableMarketEvent, global_ordering_hash
events = [
    StableMarketEvent(1710000000000, 20, 'track-02', 2),
    StableMarketEvent(1710000000000, 20, 'track-01', 2),
    StableMarketEvent(1710000000000, 20, 'track-01', 1),
]
print(json.dumps({'hash': global_ordering_hash(events)}))
"""
    hashes = []
    for seed in ("1", "777"):
        completed = subprocess.run(
            [sys.executable, "-c", program],
            cwd=Path(__file__).parents[1],
            env={**dict(os.environ), "PYTHONHASHSEED": seed},
            check=True,
            capture_output=True,
            text=True,
        )
        hashes.append(json.loads(completed.stdout)["hash"])
    assert hashes == [hashes[0], hashes[0]]


async def test_none_track_performs_zero_history_reads_then_selects_atomically(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "none-select.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        primary_session = str(created["run"]["adapter_session_id"])
        before_calls = len(service._catalog._repository.calls)  # type: ignore[attr-defined]
        primary = await service.get_session(primary_session)
        added = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "add-eth-none",
                ReplayV2CommandType.ADD_TRACK,
                primary,
                {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "ETHUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "NONE",
                },
            ),
        )
        assert added["data"]["track"]["subscription_tier"] == "NONE"
        assert added["data"]["track"]["adapter_session_id"] is None
        assert len(service._catalog._repository.calls) == before_calls  # type: ignore[attr-defined]

        selected = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "select-eth",
                ReplayV2CommandType.SELECT_TRACK,
                primary,
                {"track_id": "track-2", "expected_viewer_revision": 0},
            ),
        )
        assert selected["session_id"] == "adapter-2"
        assert selected["viewer_state"]["selected_track_id"] == "track-2"
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        by_id = {track["track_id"]: track for track in tracks["tracks"]}
        assert by_id["track-2"]["subscription_tier"] == "FULL"
        assert by_id["track-2"]["forced_full_reasons"] == ["VIEWED"]
        assert by_id["track-1"]["subscription_tier"] == "WARM"
        assert tracks["viewer_state"]["selected_track_id"] == "track-2"
        assert (
            by_id["track-2"]["cursor"]["virtual_time_ms"]
            == by_id["track-1"]["cursor"]["virtual_time_ms"]
        )
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_global_step_keeps_full_tracks_aligned_and_persists_ordering(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "global-step.db", symbols=("ETHUSDT", "SOLUSDT")
    )
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        selected = await service.get_session(selected_id)
        for index, symbol in enumerate(("ETHUSDT", "SOLUSDT"), start=1):
            await service.training.command(  # type: ignore[union-attr]
                run_id,
                _command(
                    run_id,
                    f"add-full-{index}",
                    ReplayV2CommandType.ADD_TRACK,
                    selected,
                    {
                        "exchange": "binance",
                        "market_type": "spot",
                        "symbol": symbol,
                        "settlement_asset": "USDT",
                        "subscription_tier": "FULL",
                    },
                ),
            )
        selected = await service.get_session(selected_id)
        acquired = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "acquire-all",
                ReplayV2CommandType.ACQUIRE_CONTROLLER,
                selected,
                {"takeover": False},
            ),
        )
        selected = await service.get_session(selected_id)
        stepped = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "step-all",
                ReplayV2CommandType.STEP_BASE,
                selected,
                {"count": 1},
            ),
        )
        assert acquired["data"]["full_track_count"] == 3
        assert stepped["data"]["ordering_version"] == "replay.global-order.v1"
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        full = [
            track for track in tracks["tracks"] if track["subscription_tier"] == "FULL"
        ]
        assert len({track["cursor"]["virtual_time_ms"] for track in full}) == 1
        events = await service.training.store.global_events(run_id)  # type: ignore[union-attr]
        assert [event["track_id"] for event in events] == [
            "track-1",
            "track-2",
            "track-3",
        ]
        assert (
            len({(event["track_id"], event["source_sequence"]) for event in events})
            == 3
        )
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_ordered_playback_uses_one_global_lane_and_pauses_aligned(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "global-play.db", symbols=("ETHUSDT",))
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        await _add_track(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            symbol="ETHUSDT",
            tier="FULL",
            command_id="add-play-track",
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            command_id="acquire-play-tracks",
        )
        selected = await service.get_session(selected_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "speed-play-tracks",
                ReplayV2CommandType.SET_SPEED,
                selected,
                {"speed": 600},
            ),
        )
        selected = await service.get_session(selected_id)
        playing = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "play-tracks",
                ReplayV2CommandType.PLAY,
                selected,
                {},
            ),
        )
        assert playing["state"] == "PLAYING"
        assert playing["data"]["global_clock"]["mode"] == "ORDERED"

        for _ in range(100):
            events = await service.training.store.global_events(run_id)  # type: ignore[union-attr]
            if len(events) >= 4:
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("ordered playback did not publish a two-track wave")

        stale_but_safe = selected
        paused = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "pause-tracks",
                ReplayV2CommandType.PAUSE,
                stale_but_safe,
                {},
            ),
        )
        assert paused["state"] == "PAUSED"
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert tracks["global_clock"]["state"] == "PAUSED"
        full = [
            track for track in tracks["tracks"] if track["subscription_tier"] == "FULL"
        ]
        assert len({track["cursor"]["virtual_time_ms"] for track in full}) == 1
        assert len({track["cursor"]["source_sequence"] for track in full}) == 1
        for track in full:
            adapter = await service.get_session(str(track["adapter_session_id"]))
            assert adapter["snapshot"]["state"] == "PAUSED"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_global_command_reacquires_nonselected_controller_lease(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "global-controller.db", symbols=("ETHUSDT",))
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        await _add_track(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            symbol="ETHUSDT",
            tier="FULL",
            command_id="add-controller-track",
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            command_id="acquire-controller-tracks",
        )
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        secondary_id = str(projection["tracks"][1]["adapter_session_id"])
        secondary = await service.get_session(secondary_id)
        secondary_snapshot = secondary["snapshot"]
        await service.command(
            secondary_id,
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="release-secondary-controller",
                client_instance_id="phase5-browser",
                expected_revision=int(secondary_snapshot["revision"]),
                type=CommandType.RELEASE_CONTROLLER,
                payload={},
            ),
        )
        assert (await service.get_session(secondary_id))["snapshot"][
            "controller_client_id"
        ] is None

        selected = await service.get_session(selected_id)
        changed = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "speed-after-secondary-expiry",
                ReplayV2CommandType.SET_SPEED,
                selected,
                {"speed": 30},
            ),
        )
        assert changed["data"]["full_track_count"] == 2
        recovered = await service.get_session(secondary_id)
        assert recovered["snapshot"]["controller_client_id"] == "phase5-browser"
        assert recovered["snapshot"]["speed"] == 30
        secondary_track = await service.training.store.get_market_track(  # type: ignore[union-attr]
            run_id,
            "track-2",
        )
        assert secondary_track["degraded_reason"] is None
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_multi_track_end_finalizes_every_prepared_adapter(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "global-end.db", symbols=("ETHUSDT",))
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        await _add_track(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            symbol="ETHUSDT",
            tier="FULL",
            command_id="add-end-track",
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            command_id="acquire-end-tracks",
        )
        selected = await service.get_session(selected_id)
        ended = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "end-all-tracks",
                ReplayV2CommandType.END,
                selected,
                {
                    "open_order_disposition": "expire",
                    "position_disposition": "keep",
                },
            ),
        )
        assert ended["state"] == "ENDED"
        assert ended["data"]["ended_track_count"] == 2
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert tracks["global_clock"]["state"] == "ENDED"
        for track in tracks["tracks"]:
            adapter = await service.get_session(str(track["adapter_session_id"]))
            assert adapter["snapshot"]["state"] == "ENDED"
    finally:
        await service.shutdown(step_timeout=0.2)


@pytest.mark.parametrize("track_count", (2, 4, 8))
async def test_bar_full_track_matrix_persists_stable_total_order(
    tmp_path: Path,
    track_count: int,
) -> None:
    symbols = (
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "XRPUSDT",
        "ADAUSDT",
        "BNBUSDT",
        "DOGEUSDT",
        "AVAXUSDT",
    )[:track_count]
    service = await _service(
        tmp_path / f"bar-{track_count}.db",
        symbols=symbols[1:],
    )
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        for index, symbol in enumerate(symbols[1:], start=2):
            await _add_track(
                service,
                run_id=run_id,
                selected_session_id=selected_id,
                symbol=symbol,
                tier="FULL",
                command_id=f"add-bar-full-{index}",
            )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            command_id=f"acquire-bar-{track_count}",
        )
        selected = await service.get_session(selected_id)
        stepped = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                f"step-bar-{track_count}",
                ReplayV2CommandType.STEP_BASE,
                selected,
                {"count": 1},
            ),
        )
        expected_ids = [f"track-{index}" for index in range(1, track_count + 1)]
        assert [
            event["market_track_stable_id"] for event in stepped["data"]["stable_order"]
        ] == expected_ids
        persisted = await service.training.store.global_events(run_id)  # type: ignore[union-attr]
        assert [event["track_id"] for event in persisted] == expected_ids
    finally:
        await service.shutdown(step_timeout=0.2)


@pytest.mark.parametrize("track_count", (2, 4, 8))
async def test_agg_trade_full_track_matrix_uses_the_same_stable_total_order(
    tmp_path: Path,
    track_count: int,
) -> None:
    symbols = (
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "XRPUSDT",
        "ADAUSDT",
        "BNBUSDT",
        "DOGEUSDT",
        "AVAXUSDT",
    )[:track_count]
    service = await _trade_service(
        tmp_path / f"agg-{track_count}.db",
        archive_root=tmp_path / f"agg-archive-{track_count}",
        symbols=symbols,
    )
    try:
        created = await service.training.create_run(await _trade_request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        for index, symbol in enumerate(symbols[1:], start=2):
            selected = await service.get_session(selected_id)
            await service.training.command(  # type: ignore[union-attr]
                run_id,
                _command(
                    run_id,
                    f"add-agg-full-{index}",
                    ReplayV2CommandType.ADD_TRACK,
                    selected,
                    {
                        "exchange": "binance",
                        "market_type": "futures",
                        "symbol": symbol,
                        "settlement_asset": "USDT",
                        "subscription_tier": "FULL",
                    },
                ),
            )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            command_id=f"acquire-agg-{track_count}",
        )
        selected = await service.get_session(selected_id)
        stepped = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                f"step-agg-{track_count}",
                ReplayV2CommandType.STEP_EVENT,
                selected,
                {"count": 1},
            ),
        )
        expected_ids = [f"track-{index}" for index in range(1, track_count + 1)]
        stable = stepped["data"]["stable_order"]
        assert [event["market_track_stable_id"] for event in stable] == expected_ids
        assert {event["actual_event_time_ms"] for event in stable} == {
            TRADE_REPLAY_START_MS + 1_000
        }
        persisted = await service.training.store.global_events(run_id)  # type: ignore[union-attr]
        assert [event["track_id"] for event in persisted] == expected_ids
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert (
            len({track["cursor"]["virtual_time_ms"] for track in tracks["tracks"]}) == 1
        )
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_cross_scope_and_missing_coverage_fail_without_switching_viewer(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "fail-closed.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        session = await service.get_session(session_id)
        for command_id, payload in (
            (
                "wrong-settlement",
                {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "ETHBTC",
                    "settlement_asset": "BTC",
                    "subscription_tier": "NONE",
                },
            ),
            (
                "missing-coverage",
                {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "MISSINGUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "FULL",
                },
            ),
        ):
            with pytest.raises(TrainingRunError):
                await service.training.command(  # type: ignore[union-attr]
                    run_id,
                    _command(
                        run_id,
                        command_id,
                        ReplayV2CommandType.ADD_TRACK,
                        session,
                        payload,
                    ),
                )
        viewer = await service.training.get_viewer_state(run_id)  # type: ignore[union-attr]
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert viewer["selected_track_id"] == "track-1"
        assert tracks["portfolio"]["equity"] == "10000"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_warm_track_stays_frozen_while_full_track_advances(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "warm-frozen.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        added = await _add_track(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            symbol="ETHUSDT",
            tier="WARM",
            command_id="add-eth-warm",
        )
        warm_session_id = str(added["data"]["track"]["adapter_session_id"])
        before = await service.get_session(warm_session_id)
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            command_id="acquire-primary",
        )
        selected = await service.get_session(selected_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "step-primary-only",
                ReplayV2CommandType.STEP_BASE,
                selected,
                {"count": 2},
            ),
        )
        after = await service.get_session(warm_session_id)
        assert after["snapshot"]["cursor"] == before["snapshot"]["cursor"]
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        warm = next(
            track for track in tracks["tracks"] if track["track_id"] == "track-2"
        )
        assert warm["subscription_tier"] == "WARM"
        assert warm["cursor"] == {
            "virtual_time_ms": before["snapshot"]["cursor"]["virtual_time_ms"],
            "source_sequence": before["snapshot"]["cursor"]["source_sequence"],
            "revision": before["snapshot"]["revision"],
        }
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_run_level_trade_commands_force_full_and_share_available_equity(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "shared-account.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        primary_id = str(created["run"]["adapter_session_id"])
        await _add_track(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            symbol="ETHUSDT",
            tier="NONE",
            command_id="add-eth-none-account",
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            command_id="acquire-account",
        )
        first = await _place_limit(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            command_id="reserve-primary",
            client_order_id="primary-large-order",
            quantity="180",
            limit_price="100",
        )
        assert first["data"]["account_contract"] == "SHARED_SETTLEMENT_OVERLAY_V1"
        assert Decimal(str(first["data"]["portfolio"]["reserved_margin"])) == Decimal(
            "6000"
        )

        primary = await service.get_session(primary_id)
        selected = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "select-eth-account",
                ReplayV2CommandType.SELECT_TRACK,
                primary,
                {"track_id": "track-2", "expected_viewer_revision": 0},
            ),
        )
        eth_id = str(selected["session_id"])
        tracks = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        primary_track = next(
            track for track in tracks["tracks"] if track["track_id"] == "track-1"
        )
        assert primary_track["subscription_tier"] == "FULL"
        assert primary_track["forced_full_reasons"] == ["OPEN_ORDER"]
        assert tracks["portfolio"]["available_equity"] == "4000"

        with pytest.raises(TrainingRunError) as insufficient:
            await _place_limit(
                service,
                run_id=run_id,
                selected_session_id=eth_id,
                command_id="reserve-eth-too-large",
                client_order_id="eth-large-order",
                quantity="90",
                limit_price="200",
            )
        assert insufficient.value.code == "RUN_ACCOUNT_MARGIN_EXCEEDED"
        unchanged = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert unchanged["portfolio"]["reserved_margin"] == "6000"
        assert unchanged["portfolio"]["available_equity"] == "4000"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_forced_full_downgrade_rejects_then_risk_release_checkpoints(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "forced-full.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        primary_id = str(created["run"]["adapter_session_id"])
        await _add_track(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            symbol="ETHUSDT",
            tier="NONE",
            command_id="add-risk-track",
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            command_id="acquire-risk",
        )
        primary = await service.get_session(primary_id)
        selected_eth = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "select-risk-eth",
                ReplayV2CommandType.SELECT_TRACK,
                primary,
                {"track_id": "track-2", "expected_viewer_revision": 0},
            ),
        )
        eth_id = str(selected_eth["session_id"])
        order = await _place_limit(
            service,
            run_id=run_id,
            selected_session_id=eth_id,
            command_id="place-risk-order",
            client_order_id="risk-order",
            quantity="1",
            limit_price="100",
        )
        order_id = str(order["data"]["orders"][0]["order_id"])
        eth = await service.get_session(eth_id)
        selected_primary = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "select-risk-primary",
                ReplayV2CommandType.SELECT_TRACK,
                eth,
                {"track_id": "track-1", "expected_viewer_revision": 1},
            ),
        )
        primary = await service.get_session(str(selected_primary["session_id"]))
        with pytest.raises(TrainingRunError) as forced:
            await service.training.command(  # type: ignore[union-attr]
                run_id,
                _command(
                    run_id,
                    "downgrade-risk-rejected",
                    ReplayV2CommandType.SET_SUBSCRIPTION_TIER,
                    primary,
                    {"track_id": "track-2", "subscription_tier": "WARM"},
                ),
            )
        assert forced.value.code == "MARKET_TRACK_FORCED_FULL"
        assert forced.value.details["forced_full_reasons"] == ["OPEN_ORDER"]

        selected_eth = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "select-risk-eth-again",
                ReplayV2CommandType.SELECT_TRACK,
                primary,
                {"track_id": "track-2", "expected_viewer_revision": 2},
            ),
        )
        eth = await service.get_session(str(selected_eth["session_id"]))
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "cancel-risk-order",
                ReplayV2CommandType.CANCEL_ORDER,
                eth,
                {"order_id": order_id},
            ),
        )
        eth = await service.get_session(str(selected_eth["session_id"]))
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "select-primary-after-risk",
                ReplayV2CommandType.SELECT_TRACK,
                eth,
                {"track_id": "track-1", "expected_viewer_revision": 3},
            ),
        )
        released = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        eth_track = next(
            track for track in released["tracks"] if track["track_id"] == "track-2"
        )
        assert eth_track["forced_full_reasons"] == []
        assert eth_track["subscription_tier"] == "WARM"
        with sqlite3.connect(tmp_path / "forced-full.db") as connection:
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_global_checkpoint WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
                >= 4
            )
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_full_track_preflight_failure_pauses_without_partial_wave_and_recovers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "global-failure.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        selected_id = str(created["run"]["adapter_session_id"])
        added = await _add_track(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            symbol="ETHUSDT",
            tier="FULL",
            command_id="add-failing-full",
        )
        failed_session_id = str(added["data"]["track"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_id,
            command_id="acquire-failure",
        )
        before = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        before_cursors = {
            track["track_id"]: track["cursor"] for track in before["tracks"]
        }
        original_plan = service.plan_source_chunk

        async def fail_second(session_id: str, **kwargs: object):
            if session_id == failed_session_id:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "injected frozen-history gap",
                )
            return await original_plan(session_id, **kwargs)

        monkeypatch.setattr(service, "plan_source_chunk", fail_second)
        selected = await service.get_session(selected_id)
        with pytest.raises(TrainingRunError) as paused:
            await service.training.command(  # type: ignore[union-attr]
                run_id,
                _command(
                    run_id,
                    "step-with-gap",
                    ReplayV2CommandType.STEP_BASE,
                    selected,
                    {"count": 1},
                ),
            )
        assert paused.value.code == "MULTI_TRACK_PAUSED"
        failed = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert {
            track["track_id"]: track["cursor"] for track in failed["tracks"]
        } == before_cursors
        degraded = next(
            track for track in failed["tracks"] if track["track_id"] == "track-2"
        )
        assert degraded["state"] == "DEGRADED"
        assert degraded["forced_full_reasons"] == ["REVIEW_REQUIRED"]

        # Older tier writers could restore READY without clearing the review lock.
        stale_ready = await service.training.store.set_market_track_tier(  # type: ignore[union-attr]
            run_id=run_id,
            track_id="track-2",
            subscription_tier="FULL",
        )
        assert stale_ready["state"] == "READY"
        assert stale_ready["forced_full_reasons"] == ["REVIEW_REQUIRED"]

        monkeypatch.setattr(service, "plan_source_chunk", original_plan)
        selected = await service.get_session(selected_id)
        recovered = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "recover-full-track",
                ReplayV2CommandType.SET_SUBSCRIPTION_TIER,
                selected,
                {"track_id": "track-2", "subscription_tier": "FULL"},
            ),
        )
        assert recovered["data"]["recovered_from_degradation"] is True
        selected = await service.get_session(selected_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "step-after-gap-recovery",
                ReplayV2CommandType.STEP_BASE,
                selected,
                {"count": 1},
            ),
        )
        events = await service.training.store.global_events(run_id)  # type: ignore[union-attr]
        assert [event["track_id"] for event in events] == ["track-1", "track-2"]
        assert (
            len({(event["track_id"], event["source_sequence"]) for event in events})
            == 2
        )
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_restart_restores_all_track_cursors_reasons_and_portfolio(
    tmp_path: Path,
) -> None:
    path = tmp_path / "restart.db"
    service = await _service(path)
    created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
    run_id = str(created["run"]["run_id"])
    primary_id = str(created["run"]["adapter_session_id"])
    await _add_track(
        service,
        run_id=run_id,
        selected_session_id=primary_id,
        symbol="ETHUSDT",
        tier="FULL",
        command_id="add-restart-full",
    )
    await _acquire(
        service,
        run_id=run_id,
        selected_session_id=primary_id,
        command_id="acquire-restart",
    )
    await _place_limit(
        service,
        run_id=run_id,
        selected_session_id=primary_id,
        command_id="restart-open-order",
        client_order_id="restart-order",
        quantity="1",
        limit_price="100",
    )
    before = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
    await service.shutdown(step_timeout=0.2)

    restored = await _service(path)
    try:
        after = await restored.training.get_market_tracks_by_session(primary_id)  # type: ignore[union-attr]
        assert after["tracks"] == before["tracks"]
        assert after["portfolio"] == before["portfolio"]
        with sqlite3.connect(path) as connection:
            payload = json.loads(
                connection.execute(
                    """
                    SELECT tracks_json FROM replay_training_global_checkpoint
                    WHERE run_id = ? ORDER BY checkpoint_sequence DESC LIMIT 1
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
        assert payload["portfolio"] == before["portfolio"]
        assert payload["tracks"][0]["forced_full_reasons"] == ["OPEN_ORDER", "VIEWED"]
    finally:
        await restored.shutdown(step_timeout=0.2)
