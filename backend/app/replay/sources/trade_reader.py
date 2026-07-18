"""Bounded exact aggregate-trade reader over immutable archive generations."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from typing import Any

from app.data_engine.storage.raw_trade_archive import (
    RawAggTradeArchive,
    RawAggTradeCursor,
    RawAggTradeDatasetRef,
)

from ..errors import ReplayDomainError, ReplayErrorCode


@dataclass(frozen=True, slots=True)
class ReplayTrade:
    exchange: str
    market_type: str
    symbol: str
    agg_trade_id: int
    first_trade_id: int
    last_trade_id: int
    price: str
    quantity: str
    quote_quantity: str
    trade_time_ms: int
    is_buyer_maker: bool
    source: str = "binance_public"

    def __post_init__(self) -> None:
        for field_name in ("exchange", "market_type", "symbol", "source"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} cannot be blank")
        object.__setattr__(self, "exchange", self.exchange.strip().lower())
        object.__setattr__(self, "market_type", self.market_type.strip().lower())
        object.__setattr__(self, "symbol", self.symbol.strip().upper())
        object.__setattr__(self, "source", self.source.strip().lower())
        for field_name in (
            "agg_trade_id",
            "first_trade_id",
            "last_trade_id",
            "trade_time_ms",
        ):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field_name} must be a non-negative integer")
        if self.first_trade_id > self.last_trade_id:
            raise ValueError("first_trade_id cannot exceed last_trade_id")
        for field_name in ("price", "quantity", "quote_quantity"):
            object.__setattr__(
                self,
                field_name,
                _canonical_decimal(getattr(self, field_name), field_name),
            )
        if not isinstance(self.is_buyer_maker, bool):
            raise ValueError("is_buyer_maker must be a boolean")

    @property
    def event_time_ms(self) -> int:
        return self.trade_time_ms

    @property
    def cursor(self) -> RawAggTradeCursor:
        return RawAggTradeCursor(self.trade_time_ms, self.agg_trade_id)

    @property
    def raw_trade_count(self) -> int:
        return self.last_trade_id - self.first_trade_id + 1

    def with_time_offset(self, offset_ms: int) -> "ReplayTrade":
        if isinstance(offset_ms, bool) or not isinstance(offset_ms, int):
            raise TypeError("offset_ms must be an integer")
        value = self.trade_time_ms + offset_ms
        if value < 0:
            raise ValueError("mapped replay trade time cannot be negative")
        return replace(self, trade_time_ms=value)

    def to_dict(self) -> dict[str, object]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "agg_trade_id": self.agg_trade_id,
            "first_trade_id": self.first_trade_id,
            "last_trade_id": self.last_trade_id,
            "price": self.price,
            "quantity": self.quantity,
            "quote_quantity": self.quote_quantity,
            "trade_time_ms": self.trade_time_ms,
            "is_buyer_maker": self.is_buyer_maker,
            "source": self.source,
        }

    @classmethod
    def from_archive_row(cls, payload: Mapping[str, Any]) -> "ReplayTrade":
        try:
            return cls(
                exchange=payload["exchange"],
                market_type=payload["market_type"],
                symbol=payload["symbol"],
                agg_trade_id=payload["agg_trade_id"],
                first_trade_id=payload["first_trade_id"],
                last_trade_id=payload["last_trade_id"],
                price=str(payload["price"]),
                quantity=str(payload["quantity"]),
                quote_quantity=str(payload["quote_quantity"]),
                trade_time_ms=payload["trade_time_ms"],
                is_buyer_maker=payload["is_buyer_maker"],
                source=payload["source"],
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "raw aggTrade archive row violates replay schema",
            ) from exc


@dataclass(frozen=True, slots=True)
class ReplayTradePage:
    trades: tuple[ReplayTrade, ...]
    next_cursor: RawAggTradeCursor | None
    exhausted: bool
    data_epoch: str


class PagedReplayTradeReader:
    """Validate every bounded archive page against one exact data epoch."""

    def __init__(
        self,
        archive: RawAggTradeArchive,
        dataset_ref: RawAggTradeDatasetRef,
        *,
        page_rows: int = 50_000,
        validate_generation: bool = True,
    ) -> None:
        if not isinstance(dataset_ref, RawAggTradeDatasetRef):
            raise TypeError("dataset_ref must be RawAggTradeDatasetRef")
        if not archive.enabled:
            raise ReplayDomainError(
                ReplayErrorCode.ARCHIVE_DISABLED,
                "aggregate-trade archive is disabled",
            )
        if isinstance(page_rows, bool) or not isinstance(page_rows, int):
            raise TypeError("page_rows must be an integer")
        if page_rows < 1 or page_rows > 50_000:
            raise ValueError("page_rows must be between 1 and 50000")
        if validate_generation:
            try:
                archive.validate_dataset(dataset_ref)
            except Exception as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade dataset generation failed checksum validation",
                ) from exc
        self.archive = archive
        self.dataset_ref = dataset_ref
        self.page_rows = page_rows

    @property
    def data_epoch(self) -> str:
        return self.dataset_ref.data_epoch

    def read_page(
        self,
        after: RawAggTradeCursor | None = None,
    ) -> ReplayTradePage:
        if after is not None and not isinstance(after, RawAggTradeCursor):
            raise TypeError("after must be RawAggTradeCursor or None")
        if after is not None:
            if after.agg_trade_id < self.dataset_ref.expected_first_agg_trade_id - 1:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade cursor precedes the frozen dataset",
                )
            if after.agg_trade_id > self.dataset_ref.expected_last_agg_trade_id:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade cursor exceeds the frozen dataset",
                )
            if after.agg_trade_id == self.dataset_ref.expected_last_agg_trade_id:
                return ReplayTradePage((), after, True, self.data_epoch)
        try:
            page = self.archive.scan_page(
                exchange=self.dataset_ref.exchange,
                market_type=self.dataset_ref.market_type,
                symbol=self.dataset_ref.symbol,
                start_time_ms=self.dataset_ref.start_time_ms,
                end_time_ms=self.dataset_ref.end_time_ms,
                start_agg_trade_id=self.dataset_ref.expected_first_agg_trade_id,
                end_agg_trade_id=self.dataset_ref.expected_last_agg_trade_id,
                after=after,
                limit=self.page_rows,
                dataset_ref=self.dataset_ref,
            )
        except ReplayDomainError:
            raise
        except Exception as exc:
            raise ReplayDomainError(
                ReplayErrorCode.ARCHIVE_DEGRADED,
                "aggregate-trade archive page read failed",
            ) from exc
        if page.data_epoch != self.data_epoch:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade page data epoch changed",
            )
        trades = tuple(ReplayTrade.from_archive_row(row) for row in page.rows)
        if len(trades) > self.page_rows:
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "aggregate-trade archive exceeded the page budget",
            )
        expected_id = (
            self.dataset_ref.expected_first_agg_trade_id
            if after is None
            else after.agg_trade_id + 1
        )
        previous = after
        for trade in trades:
            if (
                trade.exchange,
                trade.market_type,
                trade.symbol,
            ) != (
                self.dataset_ref.exchange,
                self.dataset_ref.market_type,
                self.dataset_ref.symbol,
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade row identity changed",
                )
            if trade.agg_trade_id != expected_id:
                raise ReplayDomainError(
                    ReplayErrorCode.DATA_GAP,
                    "aggregate-trade page contains an ID gap or duplicate",
                    details={"expected_agg_trade_id": expected_id},
                )
            if previous is not None and trade.cursor <= previous:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade cursor moved backward or repeated",
                )
            if not (
                self.dataset_ref.start_time_ms
                <= trade.trade_time_ms
                <= self.dataset_ref.end_time_ms
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade timestamp escaped the frozen dataset",
                )
            previous = trade.cursor
            expected_id += 1
        expected_cursor = trades[-1].cursor if trades else after
        if page.next_cursor != expected_cursor:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade page next cursor is inconsistent",
            )
        if not trades and not page.exhausted:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade page made no progress",
            )
        last_id = None if not trades else trades[-1].agg_trade_id
        if page.exhausted and last_id != self.dataset_ref.expected_last_agg_trade_id:
            raise ReplayDomainError(
                ReplayErrorCode.DATA_GAP,
                "aggregate-trade archive ended before the expected last ID",
            )
        if not page.exhausted and last_id == self.dataset_ref.expected_last_agg_trade_id:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade archive continued past the frozen last ID",
            )
        return ReplayTradePage(
            trades=trades,
            next_cursor=page.next_cursor,
            exhausted=page.exhausted,
            data_epoch=self.data_epoch,
        )

    def iter_pages(self) -> Iterator[ReplayTradePage]:
        cursor: RawAggTradeCursor | None = None
        while True:
            page = self.read_page(cursor)
            yield page
            if page.exhausted:
                return
            if page.next_cursor is None or page.next_cursor == cursor:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade page cursor did not advance",
                )
            cursor = page.next_cursor

    def iter_trades(self) -> Iterator[ReplayTrade]:
        for page in self.iter_pages():
            yield from page.trades


def _canonical_decimal(value: object, field_name: str) -> str:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{field_name} must be a finite Decimal") from exc
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError(f"{field_name} must be positive and finite")
    normalized = format(parsed, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized


__all__ = [
    "PagedReplayTradeReader",
    "ReplayTrade",
    "ReplayTradePage",
]
