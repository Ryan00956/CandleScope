from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Mapping

from app.replay.constants import REPLAY_PROTOCOL
from app.replay.models import FeeModel, ReplaySessionConfig, SlippageModel
from app.replay.sources.base import SourceCursor


DATA_EPOCH = "sha256:" + ("d" * 64)


@dataclass(frozen=True, slots=True)
class FixtureEvent:
    event_time_ms: int
    value: int


@dataclass(frozen=True, slots=True)
class FixtureSnapshotRef:
    data_epoch: str
    schema_version: str = "fixture-source.v1"


class FixtureSource:
    def __init__(
        self,
        events: tuple[FixtureEvent, ...],
        *,
        data_epoch: str = DATA_EPOCH,
    ) -> None:
        self._events = events
        self._data_epoch = data_epoch
        self._index = 0

    def snapshot_ref(self) -> FixtureSnapshotRef:
        return FixtureSnapshotRef(self._data_epoch)

    def fork(self) -> FixtureSource:
        forked = FixtureSource(self._events, data_epoch=self._data_epoch)
        forked._index = self._index
        return forked

    def fork_at_sequence(
        self,
        source_sequence: int,
        *,
        last_event_time_ms: int | None,
    ) -> FixtureSource:
        if isinstance(source_sequence, bool) or not isinstance(source_sequence, int):
            raise TypeError("source_sequence must be an integer")
        if source_sequence < 0 or source_sequence > len(self._events):
            raise ValueError("source_sequence exceeds fixture events")
        expected_last_time = (
            None
            if source_sequence == 0
            else self._events[source_sequence - 1].event_time_ms
        )
        if last_event_time_ms != expected_last_time:
            raise ValueError("fixture checkpoint time does not match its sequence")
        forked = self.fork()
        forked._index = source_sequence
        return forked

    def peek(self) -> FixtureEvent | None:
        if self._index >= len(self._events):
            return None
        return self._events[self._index]

    def next(self) -> FixtureEvent | None:
        event = self.peek()
        if event is not None:
            self._index += 1
        return event

    def advance_until(self, target_time_ms: int) -> tuple[FixtureEvent, ...]:
        events: list[FixtureEvent] = []
        while (event := self.peek()) is not None and event.event_time_ms <= target_time_ms:
            consumed = self.next()
            assert consumed is not None
            events.append(consumed)
        return tuple(events)

    def cursor(self) -> SourceCursor:
        previous = self._events[self._index - 1] if self._index else None
        return SourceCursor(
            source_sequence=self._index,
            last_event_time_ms=previous.event_time_ms if previous else None,
            last_base_bar_open_ms=None,
            at_end=self.exhausted(),
        )

    def exhausted(self) -> bool:
        return self._index >= len(self._events)


def event_fixture(*, count: int = 5, start_ms: int = 1_000, step_ms: int = 100) -> tuple[FixtureEvent, ...]:
    return tuple(
        FixtureEvent(event_time_ms=start_ms + (index + 1) * step_ms, value=index + 1)
        for index in range(count)
    )


def source_factory(
    events: tuple[FixtureEvent, ...],
    *,
    data_epoch: str = DATA_EPOCH,
):
    return lambda: FixtureSource(events, data_epoch=data_epoch)


def session_config(*, pause_on_controller_loss: bool = True) -> ReplaySessionConfig:
    return ReplaySessionConfig(
        protocol=REPLAY_PROTOCOL,
        source_kind="bar",  # type: ignore[arg-type]
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        base_interval="1m",
        display_interval="1m",
        start_policy="manual",  # type: ignore[arg-type]
        requested_start_ms=1_000,
        warmup_bars=0,
        horizon_ms=30 * 86_400_000,
        random_seed=20260718,
        quality_mode="exact",  # type: ignore[arg-type]
        blind_mode=False,
        initial_equity="10000",
        quote_asset="USDT",
        execution_model="paper_linear_v1",  # type: ignore[arg-type]
        fee_model=FeeModel("2", "4"),
        slippage_model=SlippageModel("fixed_bps", "1"),  # type: ignore[arg-type]
        max_leverage="5",
        pause_on_controller_loss=pause_on_controller_loss,
    )


class CountingReducer:
    def __init__(self, *, trading_state: bool = False) -> None:
        self.count = 0
        self.total = 0
        self._trading_state = trading_state

    def apply_source_event(self, event: FixtureEvent) -> Mapping[str, object]:
        self.count += 1
        self.total += event.value
        return {"count": self.count, "total": self.total}

    def snapshot(self) -> Mapping[str, object]:
        return {"count": self.count, "total": self.total}

    def restore(self, state: Mapping[str, object]) -> None:
        self.count = int(state["count"])
        self.total = int(state["total"])

    def reset(self) -> None:
        self.count = 0
        self.total = 0

    def has_trading_state(self) -> bool:
        return self._trading_state

    def final_state_transport_anchor(self) -> int | None:
        return None

    def final_state_transport_projection(
        self,
        replace_from_open_ms: int | None,
    ) -> Mapping[str, object]:
        del replace_from_open_ms
        return {"fixture_count": self.count, "fixture_total": self.total}


class GateReducer(CountingReducer):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def apply_source_event(self, event: FixtureEvent) -> Mapping[str, object]:
        self.started.set()
        await self.release.wait()
        return super().apply_source_event(event)
