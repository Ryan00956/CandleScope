from __future__ import annotations

from pathlib import Path

from app.core.config import ReplaySettings
from app.replay.constants import REPLAY_PROTOCOL
from app.replay.models import FeeModel, ReplaySessionConfig, SlippageModel
from tests.fixtures.replay.fakes import FakeKlinesRepo, FixtureIdentity, make_bar


START_MS = 1_710_000_000_000
INTERVAL_MS = 60_000
ROW_COUNT = 24
NOW_MS = START_MS + (ROW_COUNT + 2) * INTERVAL_MS


class SessionIdFactory:
    def __init__(self, prefix: str = "session") -> None:
        self._prefix = prefix
        self._counter = 0

    def __call__(self) -> str:
        self._counter += 1
        return f"{self._prefix}-{self._counter}"


def replay_settings(path: Path, *, enabled: bool = True) -> ReplaySettings:
    return ReplaySettings(
        enabled=enabled,
        db_path=path,
        max_active_sessions=8,
        command_queue_size=32,
        event_buffer_size=64,
        max_emit_fps=30,
        max_warmup_bars=100,
        max_bar_dataset_rows=1_000,
        max_horizon_days=30,
        trade_page_rows=100,
        checkpoint_event_interval=10,
        checkpoint_virtual_ms=300_000,
        event_subscriber_queue=8,
        controller_ttl_seconds=1,
        idle_ttl_seconds=60,
    )


def replay_repository() -> FakeKlinesRepo:
    identity = FixtureIdentity("binance", "spot", "BTCUSDT")
    rows = [
        make_bar(START_MS + index * INTERVAL_MS, price=str(100 + index))
        for index in range(ROW_COUNT)
    ]
    repository = FakeKlinesRepo()
    repository.add_rows(identity, "1m", rows)
    return repository


def replay_config(*, blind_mode: bool = False) -> ReplaySessionConfig:
    return ReplaySessionConfig(
        protocol=REPLAY_PROTOCOL,
        source_kind="bar",  # type: ignore[arg-type]
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        base_interval="1m",
        display_interval="1m",
        start_policy="manual",  # type: ignore[arg-type]
        requested_start_ms=START_MS + 4 * INTERVAL_MS,
        warmup_bars=2,
        horizon_ms=5 * INTERVAL_MS,
        random_seed=42,
        quality_mode="exact",  # type: ignore[arg-type]
        blind_mode=blind_mode,
        initial_equity="10000",
        quote_asset="USDT",
        execution_model="paper_linear_v1",  # type: ignore[arg-type]
        fee_model=FeeModel("2", "5"),
        slippage_model=SlippageModel("fixed_bps", "1"),  # type: ignore[arg-type]
        max_leverage="3",
        pause_on_controller_loss=True,
    )


def replay_config_payload(*, blind_mode: bool = False) -> dict[str, object]:
    return replay_config(blind_mode=blind_mode).to_dict()
