from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import zlib
from collections.abc import Mapping
from dataclasses import replace
from functools import wraps
from hashlib import sha256
from pathlib import Path

import pytest

from app.replay.actor import ReplaySessionActor
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.constants import REPLAY_PROTOCOL, CommandType, ReplayEventType
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.internal_commands import InternalCommandType
from app.replay.models import ReplayCommand
from app.replay.period_summary import (
    EncodedPeriodSummaryCandidate,
    MAX_PERIOD_SUMMARY_RAW_STATE_BYTES,
    ReplayPeriodSummary,
    decode_component_state,
    encode_component_state,
)
from app.replay.source_chain import next_source_chain_hash
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeDay,
)
from app.replay.training.commands import ReplayV2Command
from app.replay.training.models import (
    ReplayV2CommandType,
    TrainingCursor,
    TrainingRunCreateRequest,
)
from tests.fixtures.replay.actor_fakes import (
    CountingReducer,
    FixtureSource,
    event_fixture,
    session_config,
    source_factory,
)
from tests.fixtures.replay.fakes import FakeKlinesRepo, FixtureIdentity, make_bar
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    START_MS,
    SessionIdFactory,
    replay_settings,
)


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _command(
    command_id: str,
    command_type: CommandType,
    *,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="phase15-client",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


class _ReducerWithApplyCounter(CountingReducer):
    def __init__(self, *, trading_state: bool = False) -> None:
        super().__init__(trading_state=trading_state)
        self.apply_calls = 0

    def apply_source_event(self, event):
        self.apply_calls += 1
        return super().apply_source_event(event)


class _ActivePathReducer(_ReducerWithApplyCounter):
    def snapshot(self):
        return {
            **super().snapshot(),
            "orders": [{"status": "OPEN"}],
        }


def _actor(
    reducer: CountingReducer,
    *,
    event_count: int = 160,
    mutation_hook=None,
) -> ReplaySessionActor:
    events = event_fixture(count=event_count)
    return ReplaySessionActor(
        session_id="phase15-session",
        config=session_config(),
        source_factory=source_factory(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=8,
        event_buffer_size=256,
        max_emit_fps=30,
        controller_ttl_seconds=10,
        checkpoint_event_interval=16,
        checkpoint_virtual_ms=1_000,
        reducer=reducer,
        mutation_hook=mutation_hook,
    )


def _build_fixture_summary(
    authority: dict[str, object],
    *,
    event_count: int = 96,
    source_event_count: int = 160,
) -> ReplayPeriodSummary:
    source = FixtureSource(event_fixture(count=source_event_count))
    base_cursor = authority["source_cursor"]
    assert isinstance(base_cursor, dict)
    positioned = source.fork_at_sequence(
        int(base_cursor["source_sequence"]),
        last_event_time_ms=base_cursor["last_event_time_ms"],  # type: ignore[arg-type]
    )
    reducer = CountingReducer()
    chain = str(authority["event_chain_hash"])
    for _ in range(event_count):
        event = positioned.next()
        assert event is not None
        reducer.apply_source_event(event)
        chain = next_source_chain_hash(
            chain,
            event,
            positioned.cursor().source_sequence,
        )
    end_cursor = positioned.cursor()
    components = dict(reducer.snapshot())
    return ReplayPeriodSummary(
        summary_id="phase15-summary-1",
        run_id="phase15-run",
        session_id=str(authority["session_id"]),
        source_kind="BAR",
        data_epoch=str(authority["data_epoch"]),
        snapshot_ref_hash=str(authority["snapshot_ref_hash"]),
        session_config_hash=str(authority["session_config_hash"]),
        execution_version=str(authority["execution_version"]),
        rule_revision=1,
        rule_hash="sha256:" + ("f" * 64),
        base_source_sequence=int(base_cursor["source_sequence"]),
        base_domain_command_position=int(authority["domain_command_position"]),
        base_event_chain_hash=str(authority["event_chain_hash"]),
        base_component_state_hash=str(authority["component_state_hash"]),
        end_source_sequence=end_cursor.source_sequence,
        end_virtual_time_ms=int(end_cursor.last_event_time_ms),
        end_source_cursor={
            "source_sequence": end_cursor.source_sequence,
            "last_event_time_ms": end_cursor.last_event_time_ms,
            "last_base_bar_open_ms": end_cursor.last_base_bar_open_ms,
            "at_end": end_cursor.at_end,
        },
        end_event_chain_hash=chain,
        end_component_state=components,
        end_component_state_hash=canonical_sha256(components),
    )


_LONG_ROW_COUNT = 240
_LONG_NOW_MS = START_MS + (_LONG_ROW_COUNT + 2) * INTERVAL_MS
_AGG_START_MS = START_MS + 10 * INTERVAL_MS
_AGG_MINUTES = 100
_AGG_NOW_MS = _AGG_START_MS + (_AGG_MINUTES + 5) * INTERVAL_MS


def _long_repository() -> FakeKlinesRepo:
    repository = FakeKlinesRepo()
    repository.add_rows(
        FixtureIdentity("binance", "spot", "BTCUSDT"),
        "1m",
        [
            make_bar(
                START_MS + index * INTERVAL_MS,
                price=str(100 + index),
            )
            for index in range(_LONG_ROW_COUNT)
        ],
    )
    return repository


async def _bar_service(path: Path, *, optimized: bool) -> ReplayService:
    settings = replace(
        replay_settings(path),
        product_v2_enabled=True,
        replay_fast_forward_optimization_enabled=optimized,
        event_buffer_size=256,
        controller_ttl_seconds=60,
    )
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: _LONG_NOW_MS),
        repository=_long_repository(),
        now_ms=lambda: _LONG_NOW_MS,
        session_id_factory=SessionIdFactory("phase15-adapter"),
        training_run_id_factory=SessionIdFactory("phase15-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _bar_request(service: ReplayService) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=180 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=False,
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 15 BAR summary",
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
            "forward_cache_ms": 180 * INTERVAL_MS,
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


def _agg_sources(
    root: Path,
) -> tuple[FakeKlinesRepo, ParquetRawAggTradeArchive]:
    repository = FakeKlinesRepo()
    identity = FixtureIdentity("binance", "futures", "BTCUSDT")
    repository.add_rows(
        identity,
        "1m",
        [
            {
                "open_time": _AGG_START_MS + minute * INTERVAL_MS,
                "close_time": (
                    _AGG_START_MS + (minute + 1) * INTERVAL_MS - 1
                ),
                "open": 100 + minute,
                "high": 100 + minute,
                "low": 100 + minute,
                "close": 100 + minute,
                "volume": 2 if minute >= 0 else 0,
                "quote_volume": (
                    (100 + minute) * 2 if minute >= 0 else 0
                ),
                "trades": 2 if minute >= 0 else 0,
                "taker_buy_base": 1 if minute >= 0 else 0,
                "taker_buy_quote": 100 + minute if minute >= 0 else 0,
                "source": "verified_fixture",
            }
            for minute in range(-2, _AGG_MINUTES + 2)
        ],
    )
    archive = ParquetRawAggTradeArchive(
        root,
        max_rows_per_file=32,
        max_scan_rows=10_000,
        max_physical_scan_rows=10_000,
    )
    trades: list[dict[str, object]] = []
    for minute in range(_AGG_MINUTES):
        for within in range(2):
            index = minute * 2 + within
            price = 100 + minute
            timestamp = _AGG_START_MS + minute * INTERVAL_MS + 1_000 + within
            trades.append(
                {
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "BTCUSDT",
                    "agg_trade_id": 50_000 + index,
                    "first_trade_id": 500_000 + index,
                    "last_trade_id": 500_000 + index,
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
    archive.import_verified_day(
        trades,
        VerifiedRawAggTradeDay(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            date="2024-03-09",
            source_url="https://data.binance.vision/phase15.zip",
            source_file="phase15.zip",
            source_checksum_sha256=sha256(b"phase15-agg").hexdigest(),
            row_count=len(trades),
            first_agg_trade_id=50_000,
            last_agg_trade_id=50_000 + len(trades) - 1,
            first_trade_time_ms=int(trades[0]["trade_time_ms"]),
            last_trade_time_ms=int(trades[-1]["trade_time_ms"]),
        ),
    )
    return repository, archive


async def _agg_service(
    path: Path,
    archive_root: Path,
    *,
    optimized: bool,
) -> ReplayService:
    repository, archive = _agg_sources(archive_root)
    service = ReplayService(
        settings=replace(
            replay_settings(path),
            product_v2_enabled=True,
            replay_fast_forward_optimization_enabled=optimized,
            event_buffer_size=256,
            trade_page_rows=32,
            controller_ttl_seconds=60,
        ),
        store=ReplaySQLiteStore(path, now_ms=lambda: _AGG_NOW_MS),
        repository=repository,
        raw_trade_archive=archive,
        now_ms=lambda: _AGG_NOW_MS,
        session_id_factory=SessionIdFactory("phase15-agg-adapter"),
        training_run_id_factory=SessionIdFactory("phase15-agg-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _agg_request(service: ReplayService) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=_AGG_MINUTES * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=False,
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 15 AGG summary",
            "source_kind": "AGG_TRADE",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": _AGG_START_MS,
            "warmup_bars": 2,
            "forward_cache_ms": _AGG_MINUTES * INTERVAL_MS,
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


async def _create_acquired_agg_run(
    service: ReplayService,
) -> tuple[str, str]:
    assert service.training is not None
    created = await service.training.create_run(await _agg_request(service))
    run = created["run"]
    assert isinstance(run, dict)
    run_id = str(run["run_id"])
    session_id = str(run["adapter_session_id"])
    initial = await service.get_session(session_id)
    await service.training.command(
        run_id,
        _v2_command(
            run_id,
            "phase15-agg-acquire",
            ReplayV2CommandType.ACQUIRE_CONTROLLER,
            initial,
            {"takeover": False},
        ),
    )
    return run_id, session_id


def _v2_command(
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
        client_instance_id="phase15-client",
        expected_revision=revision,
        expected_cursor=TrainingCursor(
            virtual_time_ms=int(cursor["virtual_time_ms"]),
            source_sequence=int(cursor["source_sequence"]),
            revision=revision,
        ),
        type=command_type,
        payload=payload,
    )


async def _create_acquired_bar_run(
    service: ReplayService,
) -> tuple[str, str]:
    assert service.training is not None
    created = await service.training.create_run(await _bar_request(service))
    run = created["run"]
    assert isinstance(run, dict)
    run_id = str(run["run_id"])
    session_id = str(run["adapter_session_id"])
    initial = await service.get_session(session_id)
    await service.training.command(
        run_id,
        _v2_command(
            run_id,
            "phase15-acquire",
            ReplayV2CommandType.ACQUIRE_CONTROLLER,
            initial,
            {"takeover": False},
        ),
    )
    return run_id, session_id


def test_period_summary_round_trip_and_compressed_component_limits() -> None:
    state = {"account": {"equity": "10000"}, "bars": [1, 2, 3]}
    blob, raw_bytes, blob_hash, state_hash = encode_component_state(state)
    assert decode_component_state(
        blob,
        expected_raw_bytes=raw_bytes,
        expected_blob_hash=blob_hash,
        expected_state_hash=state_hash,
    ) == state

    authority = {
        "session_id": "phase15-session",
        "data_epoch": "sha256:" + ("d" * 64),
        "snapshot_ref_hash": "sha256:" + ("a" * 64),
        "session_config_hash": "sha256:" + ("b" * 64),
        "execution_version": "paper_linear_v1",
        "source_cursor": {
            "source_sequence": 0,
            "last_event_time_ms": None,
        },
        "domain_command_position": 0,
        "event_chain_hash": "sha256:" + ("c" * 64),
        "component_state_hash": canonical_sha256({"count": 0, "total": 0}),
    }
    summary = _build_fixture_summary(authority)
    assert ReplayPeriodSummary.from_dict(summary.to_dict()) == summary
    summary_blob, summary_raw, summary_blob_hash, _summary_state_hash = (
        encode_component_state(summary.end_component_state)
    )
    encoded = EncodedPeriodSummaryCandidate.from_summary(
        summary,
        component_blob=summary_blob,
        component_raw_bytes=summary_raw,
        component_blob_hash=summary_blob_hash,
    )
    assert "end_component_state" not in encoded.metadata
    assert encoded.decode() == summary

    with pytest.raises(ValueError, match="blob checksum"):
        decode_component_state(
            blob + b"x",
            expected_raw_bytes=raw_bytes,
            expected_blob_hash=blob_hash,
            expected_state_hash=state_hash,
        )
    trailing = blob + zlib.compress(b"{}")
    with pytest.raises(ValueError, match="compressed component state"):
        decode_component_state(
            trailing,
            expected_raw_bytes=raw_bytes,
            expected_blob_hash=(
                "sha256:" + hashlib.sha256(trailing).hexdigest()
            ),
            expected_state_hash=state_hash,
        )
    oversized = zlib.compress(b"x" * (MAX_PERIOD_SUMMARY_RAW_STATE_BYTES + 1))
    with pytest.raises(ValueError, match="raw byte count"):
        decode_component_state(
            oversized,
            expected_raw_bytes=MAX_PERIOD_SUMMARY_RAW_STATE_BYTES + 1,
            expected_blob_hash=(
                "sha256:" + hashlib.sha256(oversized).hexdigest()
            ),
            expected_state_hash=state_hash,
        )
    noncanonical = b'{"z":1, "a":2}'
    noncanonical_blob = zlib.compress(noncanonical)
    with pytest.raises(ValueError, match="not canonical"):
        decode_component_state(
            noncanonical_blob,
            expected_raw_bytes=len(noncanonical),
            expected_blob_hash=(
                "sha256:" + hashlib.sha256(noncanonical_blob).hexdigest()
            ),
            expected_state_hash=canonical_sha256({"a": 2, "z": 1}),
        )


@_async_test
async def test_actor_summary_jump_matches_full_reference_and_skips_reducer_calls() -> (
    None
):
    reference_reducer = _ReducerWithApplyCounter()
    jump_reducer = _ReducerWithApplyCounter()
    reference = _actor(reference_reducer)
    jump = _actor(jump_reducer)
    await reference.start()
    await jump.start()
    try:
        await reference.submit(
            _command("acquire-reference", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
        await jump.submit(
            _command("acquire-jump", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
        authority = await jump.summary_authority()
        summary = _build_fixture_summary(authority)

        reference_result = await reference.submit(
            _command(
                "reference-step",
                CommandType.STEP,
                revision=1,
                payload={"count": summary.event_count},
            )
        )
        jumped = await jump.apply_period_summary(
            summary,
            client_instance_id="phase15-client",
            expected_revision=1,
        )
        jump_snapshot = await jump.snapshot()

        assert jumped["skipped_source_events"] == summary.event_count
        assert jump_reducer.apply_calls == 0
        assert reference_reducer.apply_calls == summary.event_count
        assert jump_snapshot.cursor == reference_result.cursor
        assert jump_reducer.snapshot() == reference_reducer.snapshot()
        assert jump_snapshot.state_hash == reference_result.state_hash
        assert jump.diagnostics()["period_summary_jumps"] == 1
        assert (
            jump.diagnostics()["period_summary_skipped_events"]
            == summary.event_count
        )
    finally:
        await reference.shutdown()
        await jump.shutdown()


@_async_test
async def test_coalesced_prefix_snapshot_keeps_visible_tail_stream_causal() -> None:
    actor = _actor(_ReducerWithApplyCounter(), event_count=160)
    await actor.start()
    subscription = None
    try:
        acquired = await actor.submit(
            _command("stream-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
        subscription = await actor.subscribe(
            after_sequence=acquired.sequence,
            max_pending=128,
        )
        assert subscription.reset is True
        assert subscription.initial_events[0].sequence == acquired.sequence

        result = await actor.submit(
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="stream-fast-forward",
                client_instance_id="phase15-client",
                expected_revision=acquired.revision,
                type=InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT,  # type: ignore[arg-type]
                payload={"count": 128, "tail_events": 32},
            )
        )
        batches = []
        while not batches or batches[-1].sequence_to < result.sequence:
            batches.append(
                await asyncio.wait_for(subscription.next_event(), timeout=0.5)
            )

        next_sequence = acquired.sequence + 1
        previous_source_sequence = 0
        observed_reasons: list[str] = []
        for batch in batches:
            assert batch.sequence_from == next_sequence
            event = batch.latest_event
            if event.type is ReplayEventType.SNAPSHOT:
                snapshot = event.data["snapshot"]
                assert isinstance(snapshot, Mapping)
                source_sequence = int(snapshot["cursor"]["source_sequence"])  # type: ignore[index]
                observed_reasons.append(str(snapshot["status_reason"]))
            else:
                assert event.type is ReplayEventType.DELTA
                source_sequence = int(event.data["source_sequence"])
                assert (
                    source_sequence - previous_source_sequence
                    == batch.event_count
                )
            previous_source_sequence = source_sequence
            next_sequence = batch.sequence_to + 1

        assert observed_reasons == [
            "fast_forward_coalesced_prefix",
            "fast_forward_complete",
        ]
        assert batches[0].latest_event.type is ReplayEventType.SNAPSHOT
        assert (
            batches[0].latest_event.data["snapshot"]["cursor"]["source_sequence"]  # type: ignore[index]
            == 96
        )
        assert previous_source_sequence == 128
        assert next_sequence == result.sequence + 1
    finally:
        if subscription is not None:
            await actor.unsubscribe(subscription.token)
        await actor.shutdown()


@_async_test
async def test_actor_summary_jump_rejects_identity_lineage_activity_and_tampering() -> (
    None
):
    reducer = _ReducerWithApplyCounter()
    actor = _actor(reducer)
    await actor.start()
    try:
        await actor.submit(
            _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
        authority = await actor.summary_authority()
        summary = _build_fixture_summary(authority)

        wrong_source = replace(
            summary,
            source_kind="AGG_TRADE",
            summary_hash=None,
        )
        with pytest.raises(ReplayDomainError) as source_failure:
            await actor.apply_period_summary(
                wrong_source,
                client_instance_id="phase15-client",
                expected_revision=1,
            )
        assert source_failure.value.code is ReplayErrorCode.DATASET_MISMATCH

        object.__setattr__(summary, "summary_hash", "sha256:" + ("0" * 64))
        with pytest.raises(ReplayDomainError) as checksum_failure:
            await actor.apply_period_summary(
                summary,
                client_instance_id="phase15-client",
                expected_revision=1,
            )
        assert checksum_failure.value.code is ReplayErrorCode.DATASET_MISMATCH
        assert (await actor.snapshot()).cursor.source_sequence == 0
    finally:
        await actor.shutdown()

    trading_actor = _actor(_ActivePathReducer())
    await trading_actor.start()
    try:
        await trading_actor.submit(
            _command("acquire-trading", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
        trading_summary = _build_fixture_summary(
            await trading_actor.summary_authority()
        )
        with pytest.raises(ReplayDomainError) as trading_failure:
            await trading_actor.apply_period_summary(
                trading_summary,
                client_instance_id="phase15-client",
                expected_revision=1,
            )
        assert (
            trading_failure.value.code
            is ReplayErrorCode.INVALID_STATE_TRANSITION
        )
        assert (await trading_actor.snapshot()).cursor.source_sequence == 0
    finally:
        await trading_actor.shutdown()


@_async_test
async def test_actor_summary_jump_is_atomic_across_caller_cancel_and_commit_failure() -> (
    None
):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def gated_commit(mutation) -> None:
        if mutation.kind == "summary_jump":
            entered.set()
            await release.wait()

    cancelled_actor = _actor(
        _ReducerWithApplyCounter(),
        mutation_hook=gated_commit,
    )
    await cancelled_actor.start()
    try:
        await cancelled_actor.submit(
            _command(
                "cancel-acquire",
                CommandType.ACQUIRE_CONTROLLER,
                revision=0,
            )
        )
        summary = _build_fixture_summary(
            await cancelled_actor.summary_authority()
        )
        jump = asyncio.create_task(
            cancelled_actor.apply_period_summary(
                summary,
                client_instance_id="phase15-client",
                expected_revision=1,
            )
        )
        await asyncio.wait_for(entered.wait(), timeout=2)
        jump.cancel()
        with pytest.raises(asyncio.CancelledError):
            await jump
        release.set()
        for _attempt in range(20):
            if (
                await cancelled_actor.summary_authority()
            )["source_cursor"]["source_sequence"] == summary.end_source_sequence:  # type: ignore[index]
                break
            await asyncio.sleep(0)
        assert (
            await cancelled_actor.summary_authority()
        )["source_cursor"]["source_sequence"] == summary.end_source_sequence  # type: ignore[index]
    finally:
        release.set()
        await cancelled_actor.shutdown()

    async def failed_commit(mutation) -> None:
        if mutation.kind == "summary_jump":
            raise RuntimeError("injected summary commit failure")

    failed_reducer = _ReducerWithApplyCounter()
    failed_actor = _actor(failed_reducer, mutation_hook=failed_commit)
    await failed_actor.start()
    try:
        await failed_actor.submit(
            _command(
                "failure-acquire",
                CommandType.ACQUIRE_CONTROLLER,
                revision=0,
            )
        )
        failed_summary = _build_fixture_summary(
            await failed_actor.summary_authority()
        )
        with pytest.raises(ReplayDomainError) as failure:
            await failed_actor.apply_period_summary(
                failed_summary,
                client_instance_id="phase15-client",
                expected_revision=1,
            )
        assert failure.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
        failed_snapshot = await failed_actor.snapshot()
        assert failed_snapshot.cursor.source_sequence == 0
        assert failed_reducer.snapshot() == {"count": 0, "total": 0}
        assert failed_snapshot.state.value == "PAUSED"
        assert failed_actor.diagnostics()["degraded_reason"] is not None
    finally:
        await failed_actor.shutdown()


@_async_test
async def test_bar_summary_prepare_jump_tail_matches_reference_and_replays_intent(
    tmp_path: Path,
) -> None:
    optimized = await _bar_service(tmp_path / "optimized.db", optimized=True)
    reference = await _bar_service(tmp_path / "reference.db", optimized=False)
    try:
        optimized_run, optimized_session = await _create_acquired_bar_run(
            optimized
        )
        reference_run, reference_session = await _create_acquired_bar_run(
            reference
        )
        assert optimized.training is not None
        assert reference.training is not None

        prepared = await optimized.training.prepare_period_summaries(
            optimized_run
        )
        assert prepared["build"]["candidate_count"] >= 1  # type: ignore[index]
        assert prepared["build"]["source_event_count"] >= 64  # type: ignore[index]
        status = await optimized.training.get_period_summary_status(optimized_run)
        assert status["status"]["active_set"]["status"] == "READY"  # type: ignore[index]

        optimized_before = await optimized.get_session(optimized_session)
        reference_before = await reference.get_session(reference_session)
        target = (
            int(
                optimized_before["snapshot"]["cursor"]["virtual_time_ms"]  # type: ignore[index]
            )
            + 150 * INTERVAL_MS
        )
        planned = await optimized.training.get_fast_forward_plan(
            optimized_run,
            target_virtual_time_ms=target,
        )
        assert planned["plan"]["mode"] == "CHECKPOINT_JUMP"  # type: ignore[index]
        assert planned["plan"]["period_summary"]["status"] == "READY"  # type: ignore[index]

        advance_command = _v2_command(
            optimized_run,
            "phase15-summary-advance",
            ReplayV2CommandType.ADVANCE_TO,
            optimized_before,
            {"virtual_time_ms": target},
        )
        optimized_result = await optimized.training.command(
            optimized_run,
            advance_command,
        )
        reference_result = await reference.training.command(
            reference_run,
            _v2_command(
                reference_run,
                "phase15-reference-advance",
                ReplayV2CommandType.ADVANCE_TO,
                reference_before,
                {"virtual_time_ms": target},
            ),
        )
        assert optimized_result["data"]["summary_skipped_events"] >= 64  # type: ignore[index]
        assert optimized_result["data"]["tail_reducer_events"] < optimized_result["data"]["consumed"]  # type: ignore[index]
        assert optimized_result["data"]["plan"]["equivalence"]["status"] == (  # type: ignore[index]
            "VERIFIED_BY_CHECKPOINT_SUMMARY_TAIL"
        )
        optimized_after = await optimized.get_session(optimized_session)
        reference_after = await reference.get_session(reference_session)
        assert (
            optimized_after["snapshot"]["cursor"]  # type: ignore[index]
            == reference_after["snapshot"]["cursor"]  # type: ignore[index]
        )
        assert (
            optimized_after["snapshot"]["components"]  # type: ignore[index]
            == reference_after["snapshot"]["components"]  # type: ignore[index]
        )
        assert (
            optimized_after["snapshot"]["state_hash"]  # type: ignore[index]
            == reference_after["snapshot"]["state_hash"]  # type: ignore[index]
            == optimized_result["state_hash"]
            == reference_result["state_hash"]
        )
        optimized_report = await optimized.report(optimized_session)
        reference_report = await reference.report(reference_session)
        assert optimized_report["report"]["report_hash"] == reference_report["report"]["report_hash"]  # type: ignore[index]

        with sqlite3.connect(tmp_path / "optimized.db") as connection:
            connection.execute(
                """
                DELETE FROM replay_training_command
                WHERE run_id = ? AND command_id = ?
                """,
                (optimized_run, advance_command.command_id),
            )
        replayed = await optimized.training.command(
            optimized_run,
            advance_command,
        )
        assert replayed == optimized_result
    finally:
        await optimized.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)


@_async_test
async def test_corrupt_summary_falls_back_and_concurrent_prepare_is_single_flight(
    tmp_path: Path,
) -> None:
    database = tmp_path / "corrupt.db"
    service = await _bar_service(database, optimized=True)
    try:
        run_id, session_id = await _create_acquired_bar_run(service)
        assert service.training is not None
        entered = asyncio.Event()
        release = asyncio.Event()
        original_builder = service.prepare_period_summaries

        async def gated_builder(*args, **kwargs):
            entered.set()
            await release.wait()
            return await original_builder(*args, **kwargs)

        service.prepare_period_summaries = gated_builder  # type: ignore[method-assign]
        first = asyncio.create_task(
            service.training.prepare_period_summaries(run_id)
        )
        await asyncio.wait_for(entered.wait(), timeout=2)
        with pytest.raises(Exception) as concurrent:
            await service.training.prepare_period_summaries(run_id)
        assert getattr(concurrent.value, "code", None) == (
            "PERIOD_SUMMARY_BUILD_ACTIVE"
        )
        release.set()
        first_result = await first
        service.prepare_period_summaries = original_builder  # type: ignore[method-assign]
        active_set_id = first_result["build"]["set_id"]  # type: ignore[index]

        cancel_entered = asyncio.Event()
        cancel_release = asyncio.Event()

        async def cancellable_builder(*args, **kwargs):
            cancel_entered.set()
            await cancel_release.wait()
            return await original_builder(*args, **kwargs)

        service.prepare_period_summaries = cancellable_builder  # type: ignore[method-assign]
        cancelled_task = asyncio.create_task(
            service.training.prepare_period_summaries(run_id)
        )
        await asyncio.wait_for(cancel_entered.wait(), timeout=2)
        cancelled_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled_task
        cancelled_status = await service.training.get_period_summary_status(
            run_id
        )
        assert cancelled_status["status"]["latest_build"]["status"] == "CANCELLED"  # type: ignore[index]
        assert cancelled_status["status"]["active_set"]["set_id"] == active_set_id  # type: ignore[index]
        service.prepare_period_summaries = original_builder  # type: ignore[method-assign]

        with sqlite3.connect(database) as connection:
            connection.execute(
                """
                UPDATE replay_training_fast_forward_summary
                SET component_blob = x'00'
                WHERE rowid = (
                    SELECT rowid FROM replay_training_fast_forward_summary
                    ORDER BY end_source_sequence DESC LIMIT 1
                )
                """
            )
        current = await service.get_session(session_id)
        target = (
            int(current["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
            + 150 * INTERVAL_MS
        )
        planned = await service.training.get_fast_forward_plan(
            run_id,
            target_virtual_time_ms=target,
        )
        assert planned["plan"]["mode"] == "AGGREGATE_SCAN"  # type: ignore[index]
        assert planned["plan"]["period_summary"] == {  # type: ignore[index]
            "status": "CORRUPT",
            "reason_code": "SUMMARY_VALIDATION_FAILED",
        }
        with sqlite3.connect(database) as connection:
            assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        await service.shutdown(step_timeout=1.0)


@_async_test
async def test_summary_identity_and_generation_tampering_fail_closed(
    tmp_path: Path,
) -> None:
    database = tmp_path / "identity-corruption.db"
    service = await _bar_service(database, optimized=True)
    try:
        run_id, session_id = await _create_acquired_bar_run(service)
        assert service.training is not None
        await service.training.prepare_period_summaries(run_id)
        current = await service.get_session(session_id)
        snapshot = current["snapshot"]
        assert isinstance(snapshot, dict)
        cursor = snapshot["cursor"]
        assert isinstance(cursor, dict)
        target = int(cursor["virtual_time_ms"]) + 150 * INTERVAL_MS
        authority = await service.summary_authority(session_id)
        integrity = await service.training.store.integrity(run_id)
        identity: dict[str, object] = {
            "session_id": session_id,
            "source_kind": "BAR",
            "data_epoch": authority["data_epoch"],
            "snapshot_ref_hash": authority["snapshot_ref_hash"],
            "session_config_hash": authority["session_config_hash"],
            "execution_version": authority["execution_version"],
            "rule_revision": integrity["active_rule_revision"],
            "rule_hash": integrity["active_rule_hash"],
        }
        identity_mutations: tuple[tuple[str, object], ...] = (
            ("session_id", "different-session"),
            ("source_kind", "AGG_TRADE"),
            ("data_epoch", "sha256:" + ("0" * 64)),
            ("snapshot_ref_hash", "sha256:" + ("1" * 64)),
            ("session_config_hash", "sha256:" + ("2" * 64)),
            ("execution_version", "paper_linear_v2"),
            ("rule_revision", int(integrity["active_rule_revision"]) + 1),
            ("rule_hash", "sha256:" + ("3" * 64)),
        )
        for field_name, changed in identity_mutations:
            lookup = await service.training.store.period_summary_candidate(
                run_id=run_id,
                current_source_sequence=int(cursor["source_sequence"]),
                target_virtual_time_ms=target,
                identity={**identity, field_name: changed},
            )
            assert lookup["status"] == "INCOMPATIBLE", field_name
            assert lookup["reason_code"] == "SUMMARY_IDENTITY_MISMATCH"

        async def assert_corrupt() -> None:
            plan = await service.training.get_fast_forward_plan(
                run_id,
                target_virtual_time_ms=target,
            )
            assert plan["plan"]["mode"] == "AGGREGATE_SCAN"  # type: ignore[index]
            assert plan["plan"]["period_summary"] == {  # type: ignore[index]
                "status": "CORRUPT",
                "reason_code": "SUMMARY_VALIDATION_FAILED",
            }

        with sqlite3.connect(database) as connection:
            original_proof = connection.execute(
                """
                SELECT build_proof_hash
                FROM replay_training_fast_forward_summary_set
                WHERE run_id = ? AND active = 1
                """,
                (run_id,),
            ).fetchone()
            assert original_proof is not None
            connection.execute(
                """
                UPDATE replay_training_fast_forward_summary_set
                SET build_proof_hash = ?
                WHERE run_id = ? AND active = 1
                """,
                ("sha256:" + ("0" * 64), run_id),
            )
        await assert_corrupt()
        with sqlite3.connect(database) as connection:
            connection.execute(
                """
                UPDATE replay_training_fast_forward_summary_set
                SET build_proof_hash = ?
                WHERE run_id = ? AND active = 1
                """,
                (str(original_proof[0]), run_id),
            )
            metadata_rows = connection.execute(
                """
                SELECT set_id, summary_id, metadata_json
                FROM replay_training_fast_forward_summary
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchall()
            for set_id, summary_id, raw_metadata in metadata_rows:
                metadata = json.loads(str(raw_metadata))
                assert isinstance(metadata, dict)
                metadata["algorithm_version"] = (
                    "replay.period-summary.algorithm.tampered"
                )
                connection.execute(
                    """
                    UPDATE replay_training_fast_forward_summary
                    SET metadata_json = ?
                    WHERE set_id = ? AND summary_id = ?
                    """,
                    (canonical_json(metadata), set_id, summary_id),
                )
        await assert_corrupt()
        with sqlite3.connect(database) as connection:
            for set_id, summary_id, raw_metadata in metadata_rows:
                connection.execute(
                    """
                    UPDATE replay_training_fast_forward_summary
                    SET metadata_json = ?
                    WHERE set_id = ? AND summary_id = ?
                    """,
                    (raw_metadata, set_id, summary_id),
                )
            connection.execute(
                """
                DELETE FROM replay_training_fast_forward_summary
                WHERE rowid = (
                    SELECT rowid
                    FROM replay_training_fast_forward_summary
                    WHERE run_id = ?
                    ORDER BY end_source_sequence ASC
                    LIMIT 1
                )
                """,
                (run_id,),
            )
        await assert_corrupt()
    finally:
        await service.shutdown(step_timeout=1.0)


@_async_test
async def test_disabled_optimization_never_reads_or_prepares_summary_cache(
    tmp_path: Path,
) -> None:
    service = await _bar_service(tmp_path / "disabled.db", optimized=False)
    try:
        run_id, session_id = await _create_acquired_bar_run(service)
        assert service.training is not None

        async def forbidden(*_args, **_kwargs):
            raise AssertionError("disabled optimization read period-summary storage")

        service.training.store.period_summary_status = forbidden  # type: ignore[method-assign]
        status = await service.training.get_period_summary_status(run_id)
        assert status["enabled"] is False
        service.training.store.period_summary_candidate = forbidden  # type: ignore[method-assign]
        current = await service.get_session(session_id)
        target = (
            int(current["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
            + 150 * INTERVAL_MS
        )
        planned = await service.training.get_fast_forward_plan(
            run_id,
            target_virtual_time_ms=target,
        )
        assert planned["plan"]["mode"] == "FULL_EVENT_SCAN"  # type: ignore[index]
        with pytest.raises(Exception) as disabled:
            await service.training.prepare_period_summaries(run_id)
        assert getattr(disabled.value, "code", None) == "PERIOD_SUMMARY_DISABLED"
    finally:
        await service.shutdown(step_timeout=1.0)


@_async_test
async def test_agg_summary_jump_and_exact_tail_match_full_trade_reference(
    tmp_path: Path,
) -> None:
    optimized = await _agg_service(
        tmp_path / "agg-optimized.db",
        tmp_path / "agg-optimized-archive",
        optimized=True,
    )
    reference = await _agg_service(
        tmp_path / "agg-reference.db",
        tmp_path / "agg-reference-archive",
        optimized=False,
    )
    try:
        optimized_run, optimized_session = await _create_acquired_agg_run(
            optimized
        )
        reference_run, reference_session = await _create_acquired_agg_run(
            reference
        )
        assert optimized.training is not None
        assert reference.training is not None
        prepared = await optimized.training.prepare_period_summaries(
            optimized_run
        )
        assert prepared["build"]["source_event_count"] >= 64  # type: ignore[index]

        optimized_before = await optimized.get_session(optimized_session)
        reference_before = await reference.get_session(reference_session)
        target = (
            int(
                optimized_before["snapshot"]["cursor"]["virtual_time_ms"]  # type: ignore[index]
            )
            + 80 * INTERVAL_MS
        )
        optimized_result = await optimized.training.command(
            optimized_run,
            _v2_command(
                optimized_run,
                "phase15-agg-advance",
                ReplayV2CommandType.ADVANCE_TO,
                optimized_before,
                {"virtual_time_ms": target},
            ),
        )
        await reference.training.command(
            reference_run,
            _v2_command(
                reference_run,
                "phase15-agg-reference",
                ReplayV2CommandType.ADVANCE_TO,
                reference_before,
                {"virtual_time_ms": target},
            ),
        )
        assert optimized_result["data"]["plan"]["mode"] == "CHECKPOINT_JUMP"  # type: ignore[index]
        assert optimized_result["data"]["summary_skipped_events"] >= 64  # type: ignore[index]
        optimized_after = await optimized.get_session(optimized_session)
        reference_after = await reference.get_session(reference_session)
        assert (
            optimized_after["snapshot"]["cursor"]  # type: ignore[index]
            == reference_after["snapshot"]["cursor"]  # type: ignore[index]
        )
        assert (
            optimized_after["snapshot"]["components"]  # type: ignore[index]
            == reference_after["snapshot"]["components"]  # type: ignore[index]
        )
        assert (
            optimized_after["snapshot"]["state_hash"]  # type: ignore[index]
            == reference_after["snapshot"]["state_hash"]  # type: ignore[index]
        )
        optimized_report = await optimized.report(optimized_session)
        reference_report = await reference.report(reference_session)
        assert optimized_report["report"]["report_hash"] == reference_report["report"]["report_hash"]  # type: ignore[index]
    finally:
        await optimized.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)


@_async_test
async def test_cancel_after_summary_jump_stops_before_tail_and_resumes_exactly(
    tmp_path: Path,
) -> None:
    optimized = await _bar_service(
        tmp_path / "jump-cancel.db",
        optimized=True,
    )
    reference = await _bar_service(
        tmp_path / "jump-cancel-reference.db",
        optimized=False,
    )
    release = asyncio.Event()
    try:
        optimized_run, optimized_session = await _create_acquired_bar_run(
            optimized
        )
        reference_run, reference_session = await _create_acquired_bar_run(
            reference
        )
        assert optimized.training is not None
        assert reference.training is not None
        await optimized.training.prepare_period_summaries(optimized_run)
        optimized_before = await optimized.get_session(optimized_session)
        reference_before = await reference.get_session(reference_session)
        target = (
            int(
                optimized_before["snapshot"]["cursor"]["virtual_time_ms"]  # type: ignore[index]
            )
            + 150 * INTERVAL_MS
        )
        entered_tail = asyncio.Event()
        original_plan = optimized.plan_source_chunk

        async def gated_tail(*args, **kwargs):
            entered_tail.set()
            await release.wait()
            return await original_plan(*args, **kwargs)

        optimized.plan_source_chunk = gated_tail  # type: ignore[method-assign]
        advance = asyncio.create_task(
            optimized.training.command(
                optimized_run,
                _v2_command(
                    optimized_run,
                    "phase15-cancel-after-jump",
                    ReplayV2CommandType.ADVANCE_TO,
                    optimized_before,
                    {"virtual_time_ms": target},
                ),
            )
        )
        await asyncio.wait_for(entered_tail.wait(), timeout=2)
        jumped = await optimized.get_session(optimized_session)
        assert jumped["snapshot"]["cursor"]["source_sequence"] >= 64  # type: ignore[index]
        cancel_result = await optimized.training.command(
            optimized_run,
            _v2_command(
                optimized_run,
                "phase15-cancel-after-jump-request",
                ReplayV2CommandType.CANCEL_ADVANCE,
                jumped,
                {"advance_command_id": "phase15-cancel-after-jump"},
            ),
        )
        assert cancel_result["data"]["cancel_requested"] is True  # type: ignore[index]
        release.set()
        cancelled = await advance
        assert cancelled["data"]["cancelled"] is True  # type: ignore[index]
        assert cancelled["data"]["summary_skipped_events"] >= 64  # type: ignore[index]
        assert cancelled["data"]["tail_reducer_events"] == 0  # type: ignore[index]

        optimized.plan_source_chunk = original_plan  # type: ignore[method-assign]
        current = await optimized.get_session(optimized_session)
        current_sequence = int(
            current["snapshot"]["cursor"]["source_sequence"]  # type: ignore[index]
        )
        reference_aligned = await reference.training.command(
            reference_run,
            _v2_command(
                reference_run,
                "phase15-jump-cancel-reference-align",
                ReplayV2CommandType.STEP_BASE,
                reference_before,
                {"count": current_sequence},
            ),
        )
        assert reference_aligned["cursor"] == current["snapshot"]["cursor"]  # type: ignore[index]
        resume_target = (
            int(current["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
            + 2 * INTERVAL_MS
        )
        resumed = await optimized.training.command(
            optimized_run,
            _v2_command(
                optimized_run,
                "phase15-resume-after-jump-cancel",
                ReplayV2CommandType.ADVANCE_TO,
                current,
                {"virtual_time_ms": resume_target},
            ),
        )
        reference_current = await reference.get_session(reference_session)
        await reference.training.command(
            reference_run,
            _v2_command(
                reference_run,
                "phase15-jump-cancel-reference",
                ReplayV2CommandType.ADVANCE_TO,
                reference_current,
                {"virtual_time_ms": resume_target},
            ),
        )
        assert resumed["cursor"]["virtual_time_ms"] == resume_target  # type: ignore[index]
        optimized_after = await optimized.get_session(optimized_session)
        reference_after = await reference.get_session(reference_session)
        assert optimized_after["snapshot"]["cursor"] == reference_after["snapshot"]["cursor"]  # type: ignore[index]
        assert optimized_after["snapshot"]["components"] == reference_after["snapshot"]["components"]  # type: ignore[index]
        assert optimized_after["snapshot"]["state_hash"] == reference_after["snapshot"]["state_hash"]  # type: ignore[index]
    finally:
        release.set()
        await optimized.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)


@_async_test
async def test_tail_commit_with_lost_intent_cursor_resumes_after_restart(
    tmp_path: Path,
) -> None:
    database = tmp_path / "tail-intent-restart.db"
    service = await _bar_service(database, optimized=True)
    reference = await _bar_service(
        tmp_path / "tail-intent-reference.db",
        optimized=False,
    )
    assert service.training is not None
    assert reference.training is not None
    run_id, session_id = await _create_acquired_bar_run(service)
    reference_run, reference_session = await _create_acquired_bar_run(reference)
    await service.training.prepare_period_summaries(run_id)
    before = await service.get_session(session_id)
    reference_before = await reference.get_session(reference_session)
    target = (
        int(before["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
        + 150 * INTERVAL_MS
    )
    reference_result = await reference.training.command(
        reference_run,
        _v2_command(
            reference_run,
            "phase15-tail-response-loss-reference",
            ReplayV2CommandType.ADVANCE_TO,
            reference_before,
            {"virtual_time_ms": target},
        ),
    )
    expected_final_hash = reference_result["state_hash"]
    await reference.shutdown(step_timeout=1.0)
    command = _v2_command(
        run_id,
        "phase15-tail-response-loss",
        ReplayV2CommandType.ADVANCE_TO,
        before,
        {"virtual_time_ms": target},
    )
    original_update = service.training.store.update_advance_intent_cursor
    update_calls = 0

    async def lose_second_cursor(*args, **kwargs):
        nonlocal update_calls
        update_calls += 1
        if update_calls == 2:
            raise RuntimeError("injected tail intent cursor loss")
        return await original_update(*args, **kwargs)

    service.training.store.update_advance_intent_cursor = lose_second_cursor  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="tail intent cursor loss"):
        await service.training.command(run_id, command)
    committed = await service.get_session(session_id)
    committed_hash = committed["snapshot"]["state_hash"]  # type: ignore[index]
    assert committed["snapshot"]["cursor"]["virtual_time_ms"] == target - 1  # type: ignore[index]
    service.training.store.update_advance_intent_cursor = original_update  # type: ignore[method-assign]
    await service.shutdown(step_timeout=1.0)

    recovered = await _bar_service(database, optimized=True)
    try:
        assert recovered.training is not None
        replayed = await recovered.training.command(run_id, command)
        assert replayed["state_hash"] != committed_hash
        assert replayed["state_hash"] == expected_final_hash
        assert replayed["cursor"]["virtual_time_ms"] == target  # type: ignore[index]
        intent = await recovered.training.store.get_advance_intent(
            run_id=run_id,
            command_id=command.command_id,
            command=command.to_dict(),
        )
        assert intent is not None
        assert intent["status"] == "COMPLETED"
    finally:
        await recovered.shutdown(step_timeout=1.0)


@_async_test
async def test_running_advance_intent_resumes_after_response_loss_and_restart(
    tmp_path: Path,
) -> None:
    database = tmp_path / "intent-restart.db"
    service = await _bar_service(database, optimized=True)
    assert service.training is not None
    run_id, session_id = await _create_acquired_bar_run(service)
    await service.training.prepare_period_summaries(run_id)
    before = await service.get_session(session_id)
    target = (
        int(before["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
        + 150 * INTERVAL_MS
    )
    command = _v2_command(
        run_id,
        "phase15-lost-response",
        ReplayV2CommandType.ADVANCE_TO,
        before,
        {"virtual_time_ms": target},
    )
    original_finish = service.training.store.finish_advance_intent
    failure_injected = False

    async def lose_result_once(*args, **kwargs):
        nonlocal failure_injected
        if not failure_injected:
            failure_injected = True
            raise RuntimeError("injected response-loss boundary")
        return await original_finish(*args, **kwargs)

    service.training.store.finish_advance_intent = lose_result_once  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="response-loss"):
        await service.training.command(run_id, command)
    committed = await service.get_session(session_id)
    committed_hash = committed["snapshot"]["state_hash"]  # type: ignore[index]
    service.training.store.finish_advance_intent = original_finish  # type: ignore[method-assign]
    await service.shutdown(step_timeout=1.0)

    recovered = await _bar_service(database, optimized=True)
    try:
        assert recovered.training is not None
        replayed = await recovered.training.command(run_id, command)
        assert replayed["state_hash"] == committed_hash
        assert replayed["cursor"]["virtual_time_ms"] == target  # type: ignore[index]
        intent = await recovered.training.store.get_advance_intent(
            run_id=run_id,
            command_id=command.command_id,
            command=command.to_dict(),
        )
        assert intent is not None
        assert intent["status"] == "COMPLETED"
        authoritative = await recovered.get_session(session_id)
        assert authoritative["snapshot"]["state_hash"] == committed_hash  # type: ignore[index]
    finally:
        await recovered.shutdown(step_timeout=1.0)
