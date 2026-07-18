"""Cursor-strict aggregate-trade replay source with bounded page state."""

from __future__ import annotations

from app.data_engine.storage.raw_trade_archive import RawAggTradeCursor

from ..errors import ReplayDomainError, ReplayErrorCode
from .base import SourceCursor
from .trade_reader import PagedReplayTradeReader, ReplayTrade


class TradeReplaySource:
    def __init__(
        self,
        reader: PagedReplayTradeReader,
        *,
        time_offset_ms: int = 0,
    ) -> None:
        if not isinstance(reader, PagedReplayTradeReader):
            raise TypeError("reader must be PagedReplayTradeReader")
        if isinstance(time_offset_ms, bool) or not isinstance(time_offset_ms, int):
            raise TypeError("time_offset_ms must be an integer")
        terminal = reader.dataset_ref.end_time_ms + time_offset_ms
        if terminal < 0:
            raise ValueError("mapped aggregate-trade terminal time cannot be negative")
        self._reader = reader
        self._time_offset_ms = time_offset_ms
        self.terminal_time_ms = terminal
        self._page: tuple[ReplayTrade, ...] = ()
        self._page_index = 0
        self._fetch_cursor: RawAggTradeCursor | None = None
        self._loaded_exhausted = False
        self._source_sequence = 0
        self._last_actual: RawAggTradeCursor | None = None
        self._last_public: ReplayTrade | None = None

    def snapshot_ref(self) -> dict[str, object]:
        reference = self._reader.dataset_ref
        return {
            "schema_version": "replay-trade-source-ref.v1",
            "data_epoch": reference.data_epoch,
            "source_kind": "agg_trade",
            "exchange": reference.exchange,
            "market_type": reference.market_type,
            "symbol": reference.symbol,
            "start_time_ms": reference.start_time_ms + self._time_offset_ms,
            "end_time_ms": reference.end_time_ms + self._time_offset_ms,
            "expected_first_agg_trade_id": (
                reference.expected_first_agg_trade_id
            ),
            "expected_last_agg_trade_id": reference.expected_last_agg_trade_id,
            "row_count": reference.row_count,
            "completeness": reference.completeness,
            "source_quality": reference.source_quality,
        }

    def peek(self) -> ReplayTrade | None:
        self._ensure_page()
        if self._page_index >= len(self._page):
            return None
        return self._page[self._page_index]

    def next(self) -> ReplayTrade | None:
        event = self.peek()
        if event is None:
            return None
        actual = event.with_time_offset(-self._time_offset_ms)
        actual_cursor = actual.cursor
        if self._last_actual is not None:
            if actual_cursor <= self._last_actual:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade source cursor moved backward or repeated",
                )
            if actual.agg_trade_id != self._last_actual.agg_trade_id + 1:
                raise ReplayDomainError(
                    ReplayErrorCode.DATA_GAP,
                    "aggregate-trade source cursor contains an ID gap",
                )
        elif (
            actual.agg_trade_id
            != self._reader.dataset_ref.expected_first_agg_trade_id
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATA_GAP,
                "aggregate-trade source did not start at its expected first ID",
            )
        self._page_index += 1
        self._source_sequence += 1
        self._last_actual = actual_cursor
        self._last_public = event
        return event

    def advance_until(self, target_time_ms: int) -> tuple[ReplayTrade, ...]:
        if isinstance(target_time_ms, bool) or not isinstance(target_time_ms, int):
            raise TypeError("target_time_ms must be an integer")
        if target_time_ms < 0:
            raise ValueError("target_time_ms cannot be negative")
        values: list[ReplayTrade] = []
        while (
            event := self.peek()
        ) is not None and event.trade_time_ms <= target_time_ms:
            consumed = self.next()
            if consumed is not None:
                values.append(consumed)
        return tuple(values)

    def cursor(self) -> SourceCursor:
        last = self._last_public
        return SourceCursor(
            source_sequence=self._source_sequence,
            last_event_time_ms=None if last is None else last.trade_time_ms,
            last_base_bar_open_ms=None,
            at_end=(
                self._loaded_exhausted and self._page_index >= len(self._page)
            ),
            last_trade_time_ms=None if last is None else last.trade_time_ms,
            last_agg_trade_id=None if last is None else last.agg_trade_id,
        )

    def exhausted(self) -> bool:
        return self.peek() is None

    @property
    def buffered_count(self) -> int:
        return max(0, len(self._page) - self._page_index)

    @property
    def actual_cursor(self) -> RawAggTradeCursor | None:
        return self._last_actual

    def _ensure_page(self) -> None:
        if self._page_index < len(self._page) or self._loaded_exhausted:
            return
        page = self._reader.read_page(self._fetch_cursor)
        if page.data_epoch != self._reader.data_epoch:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade source page epoch changed",
            )
        self._page = tuple(
            trade.with_time_offset(self._time_offset_ms) for trade in page.trades
        )
        self._page_index = 0
        self._fetch_cursor = page.next_cursor
        self._loaded_exhausted = page.exhausted
        if not self._page and not self._loaded_exhausted:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade source page made no progress",
            )


__all__ = ["TradeReplaySource"]
