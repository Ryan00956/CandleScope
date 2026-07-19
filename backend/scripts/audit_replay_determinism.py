"""Cross-process deterministic golden-session audit for replay v1."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from typing import Mapping

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.actor import ReplaySessionActor  # noqa: E402
from app.replay.bars.builder import ReplayBarBuilder  # noqa: E402
from app.replay.bars.trade_builder import TradeReplayBarBuilder  # noqa: E402
from app.replay.broker.execution import ConservativeBarBroker  # noqa: E402
from app.replay.broker.ledger import LEDGER_CHAIN_SCHEMA_VERSION  # noqa: E402
from app.replay.broker.models import (  # noqa: E402
    BrokerConfig,
    BrokerLimits,
    InstrumentFilters,
    LedgerAccount,
)
from app.replay.canonical import canonical_sha256  # noqa: E402
from app.replay.catalog import ReplaySeriesIdentity  # noqa: E402
from app.replay.constants import (  # noqa: E402
    REPLAY_PROTOCOL,
    CommandType,
    ExecutionModel,
    QualityMode,
    SessionState,
    SlippageKind,
    SourceKind,
    StartPolicy,
)
from app.replay.dataset import (  # noqa: E402
    BAR_DATASET_SCHEMA_VERSION,
    BarDatasetProvenance,
    BarDatasetSnapshot,
    ReplayBar,
)
from app.replay.models import (  # noqa: E402
    FeeModel,
    ReplayCommand,
    ReplaySessionConfig,
    SlippageModel,
)
from app.replay.sources.bar_source import BarReplaySource  # noqa: E402
from app.replay.sources.trade_reader import PagedReplayTradeReader  # noqa: E402
from app.replay.sources.trade_source import TradeReplaySource  # noqa: E402
from app.data_engine.storage.raw_trade_archive import (  # noqa: E402
    REPLAY_TRADE_DATASET_SCHEMA_VERSION,
    RawAggTradeCursor,
    RawAggTradeDatasetRef,
    RawAggTradeObjectManifest,
    RawAggTradePage,
)


SCHEMA_VERSION = "replay-determinism-audit.v1"
GOLDEN_SCHEMA_VERSION = "replay-golden-session.v1"
START_MS = 1_800_057_600_000
INTERVAL_MS = 60_000
EVENT_COUNT = 6
FIRST_AGG_TRADE_ID = 50_000_000
CLIENT_ID = "replay-v1-golden-client"
PATHS = (
    "step",
    "advance",
    "max",
    "speed_step",
    "pause_step",
    "checkpoint",
    "restart",
)
SOURCES = ("bar", "agg_trade")
DEFAULT_GOLDEN_DIR = BACKEND_ROOT / "tests" / "fixtures" / "replay"


def _bar_dataset() -> BarDatasetSnapshot:
    identity = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")
    rows = tuple(
        ReplayBar(
            open_time_ms=START_MS + index * INTERVAL_MS,
            close_time_ms=START_MS + (index + 1) * INTERVAL_MS - 1,
            open=str(100 + index),
            high=str(102 + index),
            low=str(99 + index),
            close=str(101 + index),
            volume="10",
            quote_volume=str((101 + index) * 10),
            trades=10,
            taker_buy_base="5",
            taker_buy_quote=str((101 + index) * 5),
            source="replay-v1-golden",
        )
        for index in range(EVENT_COUNT)
    )
    fixture_hash = canonical_sha256(
        {
            "schema_version": "replay-golden-bar-fixture.v1",
            "rows": [row.to_dict() for row in rows],
        }
    )
    provenance = BarDatasetProvenance(
        repository_backend="generated-golden",
        identity=identity,
        interval="1m",
        source_fingerprint=fixture_hash,
        catalog_epoch=fixture_hash,
        source_earliest_open_ms=rows[0].open_time_ms,
        source_latest_open_ms=rows[-1].open_time_ms,
        source_latest_closed_open_ms=rows[-1].open_time_ms,
        row_count=len(rows),
        first_open_ms=rows[0].open_time_ms,
        last_open_ms=rows[-1].open_time_ms,
        gap_count=0,
        gap_scan_bars=len(rows),
        calendar_id="continuous-24x7",
        hash_schema="replay-golden-bar-fixture.v1",
    )
    return BarDatasetSnapshot(
        schema_version=BAR_DATASET_SCHEMA_VERSION,
        data_epoch=fixture_hash,
        identity=identity,
        interval="1m",
        rows=rows,
        warmup_bars=0,
        replay_start_index=0,
        replay_start_ms=rows[0].open_time_ms,
        replay_end_open_ms=rows[-1].open_time_ms,
        provenance=provenance,
        estimated_size_bytes=len(rows) * 512,
    )


def _trade_rows() -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
            "agg_trade_id": FIRST_AGG_TRADE_ID + index,
            "first_trade_id": 80_000_000 + index,
            "last_trade_id": 80_000_000 + index,
            "price": str(100 + index),
            "quantity": "0.5",
            "quote_quantity": str(Decimal(100 + index) * Decimal("0.5")),
            "trade_time_ms": START_MS + 1_000 + index * 1_000,
            "event_time_ms": START_MS + 1_000 + index * 1_000,
            "received_at_ms": START_MS + 1_000 + index * 1_000,
            "is_buyer_maker": index % 2 == 0,
            "source": "binance_public",
        }
        for index in range(EVENT_COUNT)
    )


def _trade_dataset() -> RawAggTradeDatasetRef:
    rows = _trade_rows()
    epoch = canonical_sha256(
        {
            "schema_version": "replay-golden-trade-fixture.v1",
            "rows": list(rows),
        }
    )
    return RawAggTradeDatasetRef(
        schema_version=REPLAY_TRADE_DATASET_SCHEMA_VERSION,
        data_epoch=epoch,
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=START_MS,
        end_time_ms=START_MS + INTERVAL_MS - 1,
        expected_first_agg_trade_id=FIRST_AGG_TRADE_ID,
        expected_last_agg_trade_id=FIRST_AGG_TRADE_ID + EVENT_COUNT - 1,
        row_count=EVENT_COUNT,
        objects=(
            RawAggTradeObjectManifest(
                object_id="golden/generated-trades.parquet",
                parquet_sha256="1" * 64,
                manifest_sha256="2" * 64,
                row_count=EVENT_COUNT,
                min_agg_trade_id=FIRST_AGG_TRADE_ID,
                max_agg_trade_id=FIRST_AGG_TRADE_ID + EVENT_COUNT - 1,
                min_trade_time_ms=int(rows[0]["trade_time_ms"]),
                max_trade_time_ms=int(rows[-1]["trade_time_ms"]),
                first_trade_time_ms=int(rows[0]["trade_time_ms"]),
                first_agg_trade_id=FIRST_AGG_TRADE_ID,
                source_quality="binance_public_checksum",
                source_checksum_sha256="3" * 64,
            ),
        ),
    )


class _GeneratedTradeArchive:
    enabled = True

    def __init__(self) -> None:
        self.rows = _trade_rows()
        self.dataset_ref = _trade_dataset()

    def validate_dataset(self, dataset_ref: RawAggTradeDatasetRef) -> None:
        if dataset_ref != self.dataset_ref:
            raise ValueError("golden aggregate-trade generation changed")

    def scan_page(
        self,
        *,
        after: RawAggTradeCursor | None,
        limit: int,
        dataset_ref: RawAggTradeDatasetRef,
        **_kwargs: object,
    ) -> RawAggTradePage:
        self.validate_dataset(dataset_ref)
        start = (
            0
            if after is None
            else after.agg_trade_id - FIRST_AGG_TRADE_ID + 1
        )
        selected = self.rows[start : start + limit]
        exhausted = start + len(selected) >= len(self.rows)
        cursor = (
            after
            if not selected
            else RawAggTradeCursor(
                trade_time_ms=int(selected[-1]["trade_time_ms"]),
                agg_trade_id=int(selected[-1]["agg_trade_id"]),
            )
        )
        return RawAggTradePage(
            rows=tuple(dict(row) for row in selected),
            next_cursor=cursor,
            exhausted=exhausted,
            data_epoch=dataset_ref.data_epoch,
        )


def _session_config(source: str) -> ReplaySessionConfig:
    is_trade = source == "agg_trade"
    return ReplaySessionConfig(
        protocol=REPLAY_PROTOCOL,
        source_kind=SourceKind.AGG_TRADE if is_trade else SourceKind.BAR,
        exchange="binance",
        market_type="futures" if is_trade else "spot",
        symbol="BTCUSDT",
        base_interval="1m",
        display_interval="1m",
        start_policy=StartPolicy.MANUAL,
        requested_start_ms=START_MS,
        warmup_bars=0,
        horizon_ms=INTERVAL_MS if is_trade else EVENT_COUNT * INTERVAL_MS,
        random_seed=20260718,
        quality_mode=QualityMode.EXACT,
        blind_mode=False,
        initial_equity="10000",
        quote_asset="USDT",
        execution_model=ExecutionModel.PAPER_LINEAR_V1,
        fee_model=FeeModel("2", "4"),
        slippage_model=SlippageModel(SlippageKind.FIXED_BPS, "1"),
        max_leverage="5",
        pause_on_controller_loss=True,
    )


def _broker_config() -> BrokerConfig:
    return BrokerConfig(
        initial_equity="10000",
        quote_asset="USDT",
        maker_bps="2",
        taker_bps="4",
        market_slippage_bps="1",
        initial_mark_price="100",
        instrument=InstrumentFilters(
            price_tick="0.1",
            quantity_step="0.001",
            min_quantity="0.001",
            max_quantity="100",
            min_notional="5",
            max_notional="1000000",
            quote_step="0.00000001",
        ),
        limits=BrokerLimits(
            max_leverage="5",
            max_position_notional="50000",
            max_order_quantity="10",
            max_open_orders=64,
            max_orders=256,
            max_fills=512,
            max_ledger_entries=4096,
            max_warnings=256,
        ),
    )


def _actor(
    source: str,
    *,
    restore_checkpoint: bytes | None = None,
) -> tuple[ReplaySessionActor, ConservativeBarBroker]:
    config = _session_config(source)
    if source == "bar":
        dataset = _bar_dataset()
        builder: ReplayBarBuilder | TradeReplayBarBuilder = ReplayBarBuilder(
            base_interval="1m",
            display_interval="1m",
            replay_start_ms=START_MS,
            warmup_bars=(),
            max_closed_bars=16,
        )

        def source_factory() -> BarReplaySource:
            return BarReplaySource(dataset)

    elif source == "agg_trade":
        archive = _GeneratedTradeArchive()
        dataset_ref = archive.dataset_ref
        builder = TradeReplayBarBuilder(
            base_interval="1m",
            display_interval="1m",
            replay_start_ms=START_MS,
            replay_end_time_ms=dataset_ref.end_time_ms,
            max_closed_bars=16,
        )

        def source_factory() -> TradeReplaySource:
            return TradeReplaySource(
                PagedReplayTradeReader(
                    archive,  # type: ignore[arg-type]
                    dataset_ref,
                    page_rows=2,
                )
            )

    else:
        raise ValueError(f"unsupported golden source: {source}")
    broker = ConservativeBarBroker(config=_broker_config(), bar_builder=builder)
    actor = ReplaySessionActor(
        session_id=f"replay-v1-golden-{source}",
        config=config,
        source_factory=source_factory,
        initial_virtual_time_ms=START_MS,
        command_queue_size=16,
        event_buffer_size=128,
        max_emit_fps=30,
        controller_ttl_seconds=60,
        checkpoint_event_interval=1,
        checkpoint_virtual_ms=1,
        reducer=broker,
        restore_checkpoint=restore_checkpoint,
    )
    return actor, broker


def _command(
    source: str,
    label: str,
    command_type: CommandType,
    revision: int,
    payload: Mapping[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=f"golden-{source}-{label}",
        client_instance_id=CLIENT_ID,
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


def _entry_payload(source: str) -> dict[str, object]:
    return {
        "client_order_id": f"golden-{source}-entry",
        "side": "BUY",
        "order_type": "MARKET",
        "quantity": "0.5" if source == "agg_trade" else "1",
        "reduce_only": False,
        "limit_price": None,
        "stop_price": None,
    }


async def _submit(
    actor: ReplaySessionActor,
    command_log: list[dict[str, object]],
    command: ReplayCommand,
) -> int:
    command_log.append(command.to_dict())
    result = await actor.submit(command)
    return result.revision


async def _common_prefix(
    source: str,
    actor: ReplaySessionActor,
    command_log: list[dict[str, object]],
) -> int:
    revision = await _submit(
        actor,
        command_log,
        _command(source, "acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    revision = await _submit(
        actor,
        command_log,
        _command(
            source,
            "entry",
            CommandType.PLACE_ORDER,
            revision,
            _entry_payload(source),
        ),
    )
    revision = await _submit(
        actor,
        command_log,
        _command(source, "entry-step", CommandType.STEP, revision, {"count": 1}),
    )
    revision = await _submit(
        actor,
        command_log,
        _command(source, "close", CommandType.CLOSE_POSITION, revision),
    )
    return revision


async def _wait_ended(actor: ReplaySessionActor) -> None:
    async def wait() -> None:
        while (await actor.snapshot()).state is not SessionState.ENDED:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait(), timeout=3)


def _terminal_time(source: str) -> int:
    if source == "agg_trade":
        return _trade_dataset().end_time_ms
    return _bar_dataset().replay_rows[-1].close_time_ms


def _independent_ledger_audit(
    broker: ConservativeBarBroker,
) -> dict[str, object]:
    entries = broker.ledger_entries
    transaction_totals: dict[str, Decimal] = {}
    for entry in entries:
        transaction_totals[entry.transaction_id] = (
            transaction_totals.get(entry.transaction_id, Decimal(0))
            + Decimal(entry.amount)
        )
    if not transaction_totals or any(value != 0 for value in transaction_totals.values()):
        raise RuntimeError("independent ledger transaction balance audit failed")

    initial_hash = canonical_sha256(
        {
            "schema_version": LEDGER_CHAIN_SCHEMA_VERSION,
            "initial_equity": broker.config.initial_equity,
            "currency": broker.config.quote_asset,
            "max_entries": broker.config.limits.max_ledger_entries,
        }
    )
    chain_hash = initial_hash
    for ordinal, entry in enumerate(entries, start=1):
        chain_hash = canonical_sha256(
            {
                "schema_version": LEDGER_CHAIN_SCHEMA_VERSION,
                "previous_hash": chain_hash,
                "ordinal": ordinal,
                "entry": entry.to_dict(),
            }
        )
    report = broker.build_report()
    if chain_hash != report.ledger_tail_hash:
        raise RuntimeError("independent ledger hash chain does not match report")

    cash_total = sum(
        (
            Decimal(entry.amount)
            for entry in entries
            if entry.account is LedgerAccount.CASH
        ),
        Decimal(0),
    )
    if cash_total != Decimal(broker.account.cash_balance):
        raise RuntimeError("independent ledger cash total does not match account")
    closed_realized = sum(
        (Decimal(trade.realized_pnl) for trade in broker.closed_trades),
        Decimal(0),
    )
    if closed_realized != Decimal(report.realized_pnl):
        raise RuntimeError("independent closed-trade PnL does not match report")

    report_payload = report.to_dict()
    report_hash = str(report_payload.pop("report_hash"))
    recomputed_report_hash = canonical_sha256(report_payload)
    if recomputed_report_hash != report_hash:
        raise RuntimeError("independent report hash audit failed")
    return {
        "balanced_transactions": len(transaction_totals),
        "entry_count": len(entries),
        "ledger_tail_hash": chain_hash,
        "cash_total": format(cash_total, "f"),
        "closed_realized_pnl": format(closed_realized, "f"),
        "report_hash": recomputed_report_hash,
        "zero_difference": True,
    }


async def _final_evidence(
    actor: ReplaySessionActor,
    broker: ConservativeBarBroker,
) -> tuple[dict[str, object], dict[str, object]]:
    snapshot = await actor.snapshot()
    if snapshot.state is not SessionState.ENDED or not snapshot.cursor.at_end:
        raise RuntimeError("golden session did not reach an immutable end state")
    report = broker.build_report()
    projection_hash = canonical_sha256(broker.bar_builder.replace_projection())
    final = {
        "actor_state_hash": snapshot.state_hash,
        "broker_state_hash": broker.state_hash,
        "report_hash": report.report_hash,
        "ledger_tail_hash": report.ledger_tail_hash,
        "projection_hash": projection_hash,
        "cursor": asdict(snapshot.cursor),
        "state": snapshot.state.value,
        "order_count": len(broker.orders),
        "fill_count": len(broker.fills),
        "closed_trade_count": len(broker.closed_trades),
        "account_hash": canonical_sha256(broker.account.to_dict()),
    }
    return final, _independent_ledger_audit(broker)


async def _finish_from_checkpoint(
    source: str,
    checkpoint: bytes,
) -> dict[str, object]:
    actor, broker = _actor(source, restore_checkpoint=checkpoint)
    command_log: list[dict[str, object]] = []
    await actor.start()
    revision = (await actor.snapshot()).revision
    revision = await _submit(
        actor,
        command_log,
        _command(source, "resume-acquire", CommandType.ACQUIRE_CONTROLLER, revision),
    )
    remaining = EVENT_COUNT - (await actor.snapshot()).cursor.source_sequence
    await _submit(
        actor,
        command_log,
        _command(
            source,
            "resume-step",
            CommandType.STEP,
            revision,
            {"count": remaining},
        ),
    )
    await _wait_ended(actor)
    final, ledger_audit = await _final_evidence(actor, broker)
    await actor.shutdown(step_timeout=1)
    return {
        "command_log": command_log,
        "checks": {"checkpoint_restored": True},
        "final": final,
        "ledger_audit": ledger_audit,
    }


async def _checkpoint_prefix(source: str) -> dict[str, object]:
    actor, _broker = _actor(source)
    command_log: list[dict[str, object]] = []
    await actor.start()
    revision = await _common_prefix(source, actor, command_log)
    await _submit(
        actor,
        command_log,
        _command(source, "prefix-step", CommandType.STEP, revision, {"count": 2}),
    )
    checkpoint = actor.latest_checkpoint_blob()
    if checkpoint is None:
        raise RuntimeError("golden checkpoint prefix produced no checkpoint")
    await actor.shutdown(step_timeout=1)
    return {
        "config": _session_config(source).to_dict(),
        "fixture_hash": _fixture_hash(source),
        "command_log": command_log,
        "checkpoint_b64": base64.b64encode(checkpoint).decode("ascii"),
        "checkpoint_sha256": hashlib.sha256(checkpoint).hexdigest(),
    }


async def _run_path(source: str, path: str) -> dict[str, object]:
    if path == "checkpoint_prefix":
        return await _checkpoint_prefix(source)
    actor, broker = _actor(source)
    command_log: list[dict[str, object]] = []
    await actor.start()
    revision = await _common_prefix(source, actor, command_log)
    checks: dict[str, object] = {}

    if path == "step":
        await _submit(
            actor,
            command_log,
            _command(
                source,
                "all-step",
                CommandType.STEP,
                revision,
                {"count": EVENT_COUNT - 1},
            ),
        )
    elif path == "advance":
        current = (await actor.snapshot()).cursor.virtual_time_ms
        await _submit(
            actor,
            command_log,
            _command(
                source,
                "all-advance",
                CommandType.ADVANCE_BY,
                revision,
                {"ms": _terminal_time(source) - current},
            ),
        )
    elif path == "max":
        revision = await _submit(
            actor,
            command_log,
            _command(
                source,
                "max-speed",
                CommandType.SET_SPEED,
                revision,
                {"speed": "MAX"},
            ),
        )
        await _submit(
            actor,
            command_log,
            _command(source, "max-play", CommandType.PLAY, revision),
        )
    elif path == "speed_step":
        revision = await _submit(
            actor,
            command_log,
            _command(
                source,
                "speed-60",
                CommandType.SET_SPEED,
                revision,
                {"speed": 60},
            ),
        )
        await _submit(
            actor,
            command_log,
            _command(
                source,
                "speed-step",
                CommandType.STEP,
                revision,
                {"count": EVENT_COUNT - 1},
            ),
        )
    elif path == "pause_step":
        revision = await _submit(
            actor,
            command_log,
            _command(
                source,
                "pause-speed",
                CommandType.SET_SPEED,
                revision,
                {"speed": 60},
            ),
        )
        revision = await _submit(
            actor,
            command_log,
            _command(source, "pause-play", CommandType.PLAY, revision),
        )
        before_pause = (await actor.snapshot()).cursor.source_sequence
        revision = await _submit(
            actor,
            command_log,
            _command(source, "pause-barrier", CommandType.PAUSE, revision),
        )
        after_pause = (await actor.snapshot()).cursor.source_sequence
        if after_pause != before_pause:
            raise RuntimeError("pause acknowledgement crossed a source-event barrier")
        checks["pause_barrier_source_sequence"] = after_pause
        await _submit(
            actor,
            command_log,
            _command(
                source,
                "pause-step",
                CommandType.STEP,
                revision,
                {"count": EVENT_COUNT - 1},
            ),
        )
    elif path == "checkpoint":
        await _submit(
            actor,
            command_log,
            _command(
                source,
                "checkpoint-step",
                CommandType.STEP,
                revision,
                {"count": 2},
            ),
        )
        checkpoint = actor.latest_checkpoint_blob()
        if checkpoint is None:
            raise RuntimeError("checkpoint path produced no checkpoint")
        await actor.shutdown(step_timeout=1)
        resumed = await _finish_from_checkpoint(source, checkpoint)
        return {
            "config": _session_config(source).to_dict(),
            "fixture_hash": _fixture_hash(source),
            "command_log": command_log + list(resumed["command_log"]),
            "checks": {
                **dict(resumed["checks"]),
                "checkpoint_sha256": hashlib.sha256(checkpoint).hexdigest(),
            },
            "final": resumed["final"],
            "ledger_audit": resumed["ledger_audit"],
        }
    else:
        raise ValueError(f"unsupported golden path: {path}")

    await _wait_ended(actor)
    final, ledger_audit = await _final_evidence(actor, broker)
    await actor.shutdown(step_timeout=1)
    return {
        "config": _session_config(source).to_dict(),
        "fixture_hash": _fixture_hash(source),
        "command_log": command_log,
        "checks": checks,
        "final": final,
        "ledger_audit": ledger_audit,
    }


def _fixture_hash(source: str) -> str:
    return (
        _trade_dataset().data_epoch
        if source == "agg_trade"
        else _bar_dataset().data_epoch
    )


def _worker_payload(args: argparse.Namespace) -> dict[str, object]:
    if args.worker_path == "restart":
        if args.checkpoint_in is None:
            raise ValueError("restart worker requires --checkpoint-in")
        return asyncio.run(
            _finish_from_checkpoint(args.worker_source, args.checkpoint_in.read_bytes())
        )
    return asyncio.run(_run_path(args.worker_source, args.worker_path))


def _run_worker(
    source: str,
    path: str,
    *,
    hash_seed: int,
    checkpoint_in: Path | None = None,
) -> dict[str, object]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker-source",
        source,
        "--worker-path",
        path,
    ]
    if checkpoint_in is not None:
        command.extend(("--checkpoint-in", str(checkpoint_in)))
    environment = dict(os.environ)
    environment["PYTHONHASHSEED"] = str(hash_seed)
    completed = subprocess.run(
        command,
        cwd=BACKEND_ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "golden worker failed "
            f"source={source} path={path} code={completed.returncode}:\n"
            f"{completed.stderr[-4000:]}"
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"golden worker returned invalid JSON: {completed.stdout[-2000:]}"
        ) from exc
    if not isinstance(payload, dict):
        raise RuntimeError("golden worker result must be an object")
    return payload


def _stable_path_result(raw: Mapping[str, object]) -> dict[str, object]:
    return {
        "command_log": raw["command_log"],
        "checks": raw["checks"],
        "final": raw["final"],
        "ledger_audit": raw["ledger_audit"],
    }


def _restart_result(source: str, *, hash_seed: int) -> dict[str, object]:
    prefix = _run_worker(source, "checkpoint_prefix", hash_seed=hash_seed)
    encoded = prefix.get("checkpoint_b64")
    if not isinstance(encoded, str):
        raise RuntimeError("checkpoint prefix omitted checkpoint bytes")
    checkpoint = base64.b64decode(encoded, validate=True)
    with tempfile.TemporaryDirectory(prefix="replay-golden-restart-") as raw_temp:
        checkpoint_path = Path(raw_temp) / "checkpoint.bin"
        checkpoint_path.write_bytes(checkpoint)
        resumed = _run_worker(
            source,
            "restart",
            hash_seed=hash_seed + 10_000,
            checkpoint_in=checkpoint_path,
        )
    return {
        "config": prefix["config"],
        "fixture_hash": prefix["fixture_hash"],
        "command_log": list(prefix["command_log"]) + list(resumed["command_log"]),
        "checks": {
            **dict(resumed["checks"]),
            "checkpoint_sha256": prefix["checkpoint_sha256"],
            "process_count": 2,
        },
        "final": resumed["final"],
        "ledger_audit": resumed["ledger_audit"],
    }


def _candidate(source: str, *, repetitions: int) -> dict[str, object]:
    raw_paths: dict[str, dict[str, object]] = {}
    for path in PATHS:
        runs = [
            (
                _restart_result(source, hash_seed=1_000 + repetition)
                if path == "restart"
                else _run_worker(
                    source,
                    path,
                    hash_seed=1_000 + repetition,
                )
            )
            for repetition in range(repetitions)
        ]
        first = runs[0]
        if any(value != first for value in runs[1:]):
            raise RuntimeError(
                f"cross-process result drifted for source={source} path={path}"
            )
        raw_paths[path] = _stable_path_result(first)

    finals = [canonical_sha256(raw_paths[path]["final"]) for path in PATHS]
    ledger_audits = [
        canonical_sha256(raw_paths[path]["ledger_audit"]) for path in PATHS
    ]
    if len(set(finals)) != 1:
        raise RuntimeError(f"operation paths diverged for source={source}: {finals}")
    if len(set(ledger_audits)) != 1:
        raise RuntimeError(f"ledger audits diverged for source={source}")
    config = _session_config(source).to_dict()
    baseline = raw_paths[PATHS[0]]
    logs = [list(raw_paths[path]["command_log"]) for path in PATHS]
    common_length = 0
    while all(len(log) > common_length for log in logs):
        candidate_command = logs[0][common_length]
        if any(log[common_length] != candidate_command for log in logs[1:]):
            break
        common_length += 1
    return {
        "schema_version": GOLDEN_SCHEMA_VERSION,
        "source_kind": SourceKind.AGG_TRADE.value if source == "agg_trade" else SourceKind.BAR.value,
        "fixture_hash": _fixture_hash(source),
        "config": config,
        "command_log": {
            "common_prefix": logs[0][:common_length],
            "paths": {
                path: {
                    "suffix": logs[index][common_length:],
                    "checks": raw_paths[path]["checks"],
                }
                for index, path in enumerate(PATHS)
            },
        },
        "final": baseline["final"],
        "ledger_audit": baseline["ledger_audit"],
        "equivalence": {
            "paths": list(PATHS),
            "final_evidence_hash": finals[0],
            "ledger_audit_hash": ledger_audits[0],
            "cross_process_repetitions": repetitions,
            "all_equal": True,
        },
    }


def _golden_path(golden_dir: Path, source: str) -> Path:
    name = (
        "golden_agg_trade_session_v1.json"
        if source == "agg_trade"
        else "golden_bar_session_v1.json"
    )
    return golden_dir / name


def _parent_payload(args: argparse.Namespace) -> dict[str, object]:
    if args.repetitions < 2:
        raise ValueError("--repetitions must be at least 2")
    candidates = {
        source: _candidate(source, repetitions=args.repetitions)
        for source in SOURCES
    }
    if args.print_candidates:
        return {
            "schema_version": SCHEMA_VERSION,
            "candidates": candidates,
        }

    results: dict[str, object] = {}
    for source, candidate in candidates.items():
        path = _golden_path(args.golden_dir, source)
        if not path.is_file():
            raise RuntimeError(f"golden session is missing: {path}")
        expected = json.loads(path.read_text(encoding="utf-8"))
        if expected != candidate:
            raise RuntimeError(
                f"golden session drifted for {source}; regenerate and review explicitly"
            )
        equivalence = candidate["equivalence"]
        assert isinstance(equivalence, Mapping)
        results[source] = {
            "golden_file": path.relative_to(BACKEND_ROOT.parent).as_posix(),
            "golden_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "fixture_hash": candidate["fixture_hash"],
            "final_evidence_hash": equivalence["final_evidence_hash"],
            "ledger_audit_hash": equivalence["ledger_audit_hash"],
            "paths": list(PATHS),
            "cross_process_repetitions": args.repetitions,
            "passed": True,
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "passed": True,
        "python": sys.version.split()[0],
        "sources": results,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run BAR and AGG_TRADE golden sessions in independent Python "
            "processes and verify deterministic hashes."
        )
    )
    parser.add_argument(
        "--golden-dir",
        type=Path,
        default=DEFAULT_GOLDEN_DIR,
    )
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--print-candidates", action="store_true")
    parser.add_argument("--worker-source", choices=SOURCES)
    parser.add_argument(
        "--worker-path",
        choices=(*PATHS, "checkpoint_prefix"),
    )
    parser.add_argument("--checkpoint-in", type=Path)
    args = parser.parse_args()
    if (args.worker_source is None) != (args.worker_path is None):
        parser.error("--worker-source and --worker-path must be supplied together")
    return args


def main() -> int:
    args = parse_args()
    payload = (
        _worker_payload(args)
        if args.worker_source is not None
        else _parent_payload(args)
    )
    print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
