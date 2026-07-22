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
        blind_mode: bool = False,
    ) -> None:
        if not isinstance(reader, PagedReplayTradeReader):
            raise TypeError("reader must be PagedReplayTradeReader")
        if isinstance(time_offset_ms, bool) or not isinstance(time_offset_ms, int):
            raise TypeError("time_offset_ms must be an integer")
        if not isinstance(blind_mode, bool):
            raise TypeError("blind_mode must be a boolean")
        terminal = reader.dataset_ref.end_time_ms + time_offset_ms
        if terminal < 0:
            raise ValueError("mapped aggregate-trade terminal time cannot be negative")
        self._reader = reader
        self._time_offset_ms = time_offset_ms
        self._blind_mode = blind_mode
        self.terminal_time_ms = terminal
        self._page: tuple[ReplayTrade, ...] = ()
        self._page_index = 0
        self._fetch_cursor: RawAggTradeCursor | None = None
        self._loaded_exhausted = False
        self._source_sequence = 0
        self._last_actual: RawAggTradeCursor | None = None
        self._last_public_time_ms: int | None = None
        self._last_public_agg_trade_id: int | None = None
        self._first_actual_trade_id: int | None = None

    def snapshot_ref(self) -> dict[str, object]:
        reference = self._reader.dataset_ref
        expected_first_id = (
            1 if self._blind_mode else reference.expected_first_agg_trade_id
        )
        expected_last_id = (
            reference.row_count
            if self._blind_mode
            else reference.expected_last_agg_trade_id
        )
        return {
            "schema_version": "replay-trade-source-ref.v1",
            "data_epoch": reference.data_epoch,
            "source_kind": "agg_trade",
            "exchange": reference.exchange,
            "market_type": reference.market_type,
            "symbol": reference.symbol,
            "start_time_ms": reference.start_time_ms + self._time_offset_ms,
            "end_time_ms": reference.end_time_ms + self._time_offset_ms,
            "expected_first_agg_trade_id": expected_first_id,
            "expected_last_agg_trade_id": expected_last_id,
            "row_count": reference.row_count,
            "completeness": reference.completeness,
            "source_quality": reference.source_quality,
        }

    def fork(self) -> TradeReplaySource:
        """Return an isolated O(1) cursor sharing only immutable reader/page data."""

        forked = object.__new__(TradeReplaySource)
        forked._reader = self._reader
        forked._time_offset_ms = self._time_offset_ms
        forked._blind_mode = self._blind_mode
        forked.terminal_time_ms = self.terminal_time_ms
        forked._page = self._page
        forked._page_index = self._page_index
        forked._fetch_cursor = self._fetch_cursor
        forked._loaded_exhausted = self._loaded_exhausted
        forked._source_sequence = self._source_sequence
        forked._last_actual = self._last_actual
        forked._last_public_time_ms = self._last_public_time_ms
        forked._last_public_agg_trade_id = self._last_public_agg_trade_id
        forked._first_actual_trade_id = self._first_actual_trade_id
        return forked

    def fork_at_sequence(
        self,
        source_sequence: int,
        *,
        last_event_time_ms: int | None,
    ) -> TradeReplaySource:
        """Position an isolated paged cursor from durable sequence metadata."""

        if isinstance(source_sequence, bool) or not isinstance(source_sequence, int):
            raise TypeError("source_sequence must be an integer")
        row_count = self._reader.dataset_ref.row_count
        if source_sequence < 0 or source_sequence > row_count:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade checkpoint sequence exceeds the frozen dataset",
            )
        if source_sequence == 0:
            if last_event_time_ms is not None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "initial aggregate-trade cursor cannot have a last event time",
                )
            forked = self.fork()
            forked._page = ()
            forked._page_index = 0
            forked._fetch_cursor = None
            forked._loaded_exhausted = False
            forked._source_sequence = 0
            forked._last_actual = None
            forked._last_public_time_ms = None
            forked._last_public_agg_trade_id = None
            forked._first_actual_trade_id = None
            return forked
        if (
            isinstance(last_event_time_ms, bool)
            or not isinstance(last_event_time_ms, int)
            or last_event_time_ms < self._time_offset_ms
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade checkpoint event time is invalid",
            )
        if self._blind_mode and self._first_actual_trade_id is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "blind aggregate-trade source cannot reconstruct its origin",
            )
        actual_agg_trade_id = (
            self._reader.dataset_ref.expected_first_agg_trade_id
            + source_sequence
            - 1
        )
        actual_cursor = RawAggTradeCursor(
            last_event_time_ms - self._time_offset_ms,
            actual_agg_trade_id,
        )
        forked = self.fork()
        forked._page = ()
        forked._page_index = 0
        forked._fetch_cursor = actual_cursor
        forked._loaded_exhausted = source_sequence == row_count
        forked._source_sequence = source_sequence
        forked._last_actual = actual_cursor
        forked._last_public_time_ms = last_event_time_ms
        forked._last_public_agg_trade_id = (
            source_sequence if self._blind_mode else actual_agg_trade_id
        )
        return forked

    def peek(self) -> ReplayTrade | None:
        self._ensure_page()
        if self._page_index >= len(self._page):
            return None
        return self._public_trade(self._page[self._page_index])

    def next(self) -> ReplayTrade | None:
        event = self.peek()
        if event is None:
            return None
        actual = self._page[self._page_index]
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
            actual.agg_trade_id != self._reader.dataset_ref.expected_first_agg_trade_id
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATA_GAP,
                "aggregate-trade source did not start at its expected first ID",
            )
        self._page_index += 1
        self._source_sequence += 1
        self._last_actual = actual_cursor
        self._last_public_time_ms = event.trade_time_ms
        self._last_public_agg_trade_id = event.agg_trade_id
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
        return SourceCursor(
            source_sequence=self._source_sequence,
            last_event_time_ms=self._last_public_time_ms,
            last_base_bar_open_ms=None,
            at_end=(self._loaded_exhausted and self._page_index >= len(self._page)),
            last_trade_time_ms=self._last_public_time_ms,
            last_agg_trade_id=self._last_public_agg_trade_id,
        )

    def exhausted(self) -> bool:
        return self.peek() is None

    @property
    def buffered_count(self) -> int:
        return max(0, len(self._page) - self._page_index)

    @property
    def actual_cursor(self) -> RawAggTradeCursor | None:
        return self._last_actual

    def read_revealed_page(
        self,
        *,
        after_sequence: int,
        limit: int,
    ) -> dict[str, object]:
        """Read a bounded immutable page without moving the replay cursor."""

        revealed_sequence = self._source_sequence
        page = self._reader.read_sequence_page(
            after_sequence=after_sequence,
            revealed_sequence=revealed_sequence,
            limit=limit,
        )
        if self._blind_mode and self._first_actual_trade_id is None and page.trades:
            origin = self._reader.read_sequence_page(
                after_sequence=0,
                revealed_sequence=revealed_sequence,
                limit=1,
            )
            if not origin.trades:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "blind aggregate-trade identity origin is unavailable",
                )
            self._first_actual_trade_id = origin.trades[0].first_trade_id
        trades = tuple(self._public_trade(trade) for trade in page.trades)
        return {
            "data_epoch": page.data_epoch,
            "after_sequence": page.after_sequence,
            "next_sequence": page.next_sequence,
            "revealed_sequence": page.revealed_sequence,
            "has_more": page.has_more,
            "events": [
                {
                    "source_sequence": page.after_sequence + index + 1,
                    **trade.to_dict(),
                }
                for index, trade in enumerate(trades)
            ],
            "streaming": {
                "page_rows": len(trades),
                "resident_pages": 1,
                "prefetch_pages": 1,
                "backpressure": "ACTOR_MAILBOX",
            },
        }

    def _ensure_page(self) -> None:
        if self._page_index < len(self._page) or self._loaded_exhausted:
            return
        try:
            page = self._reader.read_page(self._fetch_cursor)
        except ReplayDomainError as exc:
            if not self._blind_mode:
                raise
            raise ReplayDomainError(
                exc.code,
                "blind aggregate-trade source validation failed",
                details={"blind_redacted": True},
            ) from exc
        if page.data_epoch != self._reader.data_epoch:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade source page epoch changed",
            )
        self._page = page.trades
        self._page_index = 0
        self._fetch_cursor = page.next_cursor
        self._loaded_exhausted = page.exhausted
        if not self._page and not self._loaded_exhausted:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade source page made no progress",
            )

    def _public_trade(self, actual: ReplayTrade) -> ReplayTrade:
        public = actual.with_time_offset(self._time_offset_ms)
        if not self._blind_mode:
            return public
        if self._first_actual_trade_id is None:
            self._first_actual_trade_id = actual.first_trade_id
        public_raw_origin = self._first_actual_trade_id
        return public.with_public_identity(
            agg_trade_id=(
                actual.agg_trade_id
                - self._reader.dataset_ref.expected_first_agg_trade_id
                + 1
            ),
            first_trade_id=actual.first_trade_id - public_raw_origin + 1,
            last_trade_id=actual.last_trade_id - public_raw_origin + 1,
        )


__all__ = ["TradeReplaySource"]
