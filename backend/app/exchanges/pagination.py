from __future__ import annotations

from typing import Protocol


class HistoricalPaginationPolicy(Protocol):
    """Exchange-owned pagination policy for historical REST backfills."""

    def first_request(
        self,
        task,
        *,
        batch_size: int,
        now_ms: int,
    ) -> TransportRequest:
        ...

    def next_request(
        self,
        task,
        previous_request: TransportRequest,
        bars: list,
        *,
        batch_size: int,
    ) -> TransportRequest | None:
        ...


class ReverseTimePaginationPolicy:
    """Default inclusive time-window pagination used by Binance-like APIs."""

    def first_request(
        self,
        task,
        *,
        batch_size: int,
        now_ms: int,
    ) -> TransportRequest:
        from app.data_engine.ingestion.models import TransportRequest

        return TransportRequest(
            descriptor=self._descriptor(task),
            limit=batch_size,
            start_ms=int(task.start_ms) if task.start_ms is not None else None,
            end_ms=int(task.end_ms) if task.end_ms is not None else now_ms,
        )

    def next_request(
        self,
        task,
        previous_request: TransportRequest,
        bars: list,
        *,
        batch_size: int,
    ) -> TransportRequest | None:
        from app.data_engine.ingestion.models import TransportRequest

        if not bars:
            return None
        cursor_end_ms = previous_request.end_ms
        if cursor_end_ms is None:
            return None
        oldest_bar_time = min(int(bar.open_time) for bar in bars)
        if oldest_bar_time >= cursor_end_ms:
            return None
        if task.start_ms is not None and oldest_bar_time <= task.start_ms:
            return None
        return TransportRequest(
            descriptor=previous_request.descriptor,
            limit=batch_size,
            start_ms=int(task.start_ms) if task.start_ms is not None else None,
            end_ms=oldest_bar_time - 1,
        )

    @staticmethod
    def _descriptor(task) -> StreamDescriptor:
        from app.data_engine.ingestion.models import StreamDescriptor, StreamType

        return StreamDescriptor(
            symbol=task.symbol,
            stream_type=StreamType.KLINE,
            interval=task.interval,
            exchange=task.exchange,
            market_type=task.market_type,
        )


class OkxHistoricalPaginationPolicy(ReverseTimePaginationPolicy):
    """OKX historical pagination policy.

    TransportRequest keeps CandleScope's inclusive start/end intent. The OKX
    protocol converts those bounds to OKX's exclusive before/after params.
    """
