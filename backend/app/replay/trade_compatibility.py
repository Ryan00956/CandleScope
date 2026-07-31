"""Offline proof that an exact aggTrade tape matches one BAR archive revision."""

from __future__ import annotations

from collections.abc import Mapping

from app.data_engine.interval_policy import parse_interval_ms
from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeBarWindow,
)

from .bars.trade_builder import TradeReplayBarBuilder
from .bars.trade_parity import audit_trade_bar_parity, trade_bar_parity_policy
from .sources.trade_reader import PagedReplayTradeReader


def build_trade_bar_compatibility(
    raw_archive: ParquetRawAggTradeArchive,
    bar_repository: object,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
    start_time_ms: int,
    end_time_ms: int,
    bar_source_revision: str,
    page_rows: int = 50_000,
) -> dict[str, object]:
    """Audit every BAR once and atomically publish compact matching segments."""

    interval_ms = parse_interval_ms(interval)
    if interval_ms is None:
        raise ValueError("trade/BAR compatibility requires a fixed interval")
    if (
        start_time_ms < 0
        or end_time_ms < start_time_ms
        or start_time_ms % interval_ms != 0
        or (end_time_ms + 1) % interval_ms != 0
    ):
        raise ValueError("trade/BAR compatibility range must use closed BAR bounds")
    if page_rows < 1 or page_rows > 50_000:
        raise ValueError("page_rows must be between 1 and 50000")
    checked_bar_count = (
        (end_time_ms - start_time_ms + 1) // interval_ms
    )
    if checked_bar_count > 100_000:
        raise ValueError("trade/BAR compatibility range exceeds 100000 BARs")

    query_at_revision = getattr(
        bar_repository,
        "query_bars_at_revision",
        None,
    )
    if callable(query_at_revision):
        reference_rows = query_at_revision(
            bar_source_revision,
            symbol,
            interval,
            start_ms=start_time_ms,
            end_ms=end_time_ms,
            limit=checked_bar_count,
            order="ASC",
            exchange=exchange,
            market_type=market_type,
        )
    else:
        reference_rows = bar_repository.query_bars(
            symbol,
            interval,
            start_ms=start_time_ms,
            end_ms=end_time_ms,
            limit=checked_bar_count,
            order="ASC",
            exchange=exchange,
            market_type=market_type,
        )
    reference_by_open: dict[int, Mapping[str, object]] = {}
    for row in reference_rows:
        if not isinstance(row, Mapping):
            raise TypeError("BAR compatibility source returned an invalid row")
        open_time_ms = int(row["open_time"])
        if open_time_ms in reference_by_open:
            raise ValueError("BAR compatibility source contains duplicate opens")
        reference_by_open[open_time_ms] = row
    expected_opens = tuple(
        range(start_time_ms, end_time_ms + 1, interval_ms)
    )
    if set(reference_by_open) != set(expected_opens):
        raise ValueError(
            "BAR compatibility source is missing one or more closed intervals"
        )

    dataset_ref = raw_archive.freeze_dataset(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        start_time_ms=start_time_ms,
        end_time_ms=end_time_ms,
        page_rows=page_rows,
    )
    reader = PagedReplayTradeReader(
        raw_archive,
        dataset_ref,
        page_rows=page_rows,
    )
    builder = TradeReplayBarBuilder(
        base_interval=interval,
        display_interval=interval,
        replay_start_ms=start_time_ms,
        replay_end_time_ms=end_time_ms,
        warmup_bars=(),
        max_closed_bars=checked_bar_count,
    )
    consumed_rows = 0
    for trade in reader.iter_trades():
        builder.apply_trade(trade)
        consumed_rows += 1
    if consumed_rows != dataset_ref.row_count:
        raise RuntimeError("trade/BAR compatibility scan row count changed")
    builder.finalize_bars(virtual_time_ms=end_time_ms)
    derived_by_open = {
        bar.open_time_ms: bar
        for bar in builder.closed_bars
        if start_time_ms <= bar.open_time_ms <= end_time_ms
    }

    parity_policy = trade_bar_parity_policy(compare_trade_count=False)
    matching_opens: list[int] = []
    mismatch_examples: list[dict[str, object]] = []
    for open_time_ms in expected_opens:
        derived = derived_by_open.get(open_time_ms)
        if derived is None:
            if len(mismatch_examples) < 100:
                mismatch_examples.append(
                    {
                        "open_time_ms": open_time_ms,
                        "field": "row_missing",
                        "expected": "closed_bar",
                        "actual": None,
                        "allowed_error": None,
                    }
                )
            continue
        report = audit_trade_bar_parity(
            (derived,),
            (reference_by_open[open_time_ms],),
            compare_trade_count=False,
        )
        if report.exact_enough:
            matching_opens.append(open_time_ms)
        elif len(mismatch_examples) < 100:
            mismatch_examples.extend(
                item.to_dict()
                for item in report.mismatches[
                    : 100 - len(mismatch_examples)
                ]
            )

    windows: list[VerifiedRawAggTradeBarWindow] = []
    first_open: int | None = None
    last_open: int | None = None
    for open_time_ms in (*matching_opens, None):
        if (
            open_time_ms is not None
            and (
                last_open is None
                or open_time_ms == last_open + interval_ms
            )
        ):
            first_open = open_time_ms if first_open is None else first_open
            last_open = open_time_ms
            continue
        if first_open is not None and last_open is not None:
            windows.append(
                VerifiedRawAggTradeBarWindow(
                    start_time_ms=first_open,
                    end_time_ms=last_open + interval_ms - 1,
                    bar_count=((last_open - first_open) // interval_ms) + 1,
                )
            )
        first_open = open_time_ms
        last_open = open_time_ms

    mismatch_bar_count = checked_bar_count - len(matching_opens)
    published = raw_archive.publish_bar_compatibility(
        dataset_ref=dataset_ref,
        interval=interval,
        interval_ms=interval_ms,
        bar_source_revision=bar_source_revision,
        parity_policy=parity_policy,
        checked_bar_count=checked_bar_count,
        mismatch_bar_count=mismatch_bar_count,
        compatible_windows=windows,
    )
    return {
        "schema_version": "replay-trade-bar-compatibility-build.v1",
        "identity": {
            "exchange": dataset_ref.exchange,
            "market_type": dataset_ref.market_type,
            "symbol": dataset_ref.symbol,
        },
        "interval": interval,
        "bar_source_revision": bar_source_revision,
        "raw_data_epoch": dataset_ref.data_epoch,
        "raw_row_count": dataset_ref.row_count,
        "checked_bar_count": checked_bar_count,
        "matching_bar_count": len(matching_opens),
        "mismatch_bar_count": mismatch_bar_count,
        "compatible_windows": [item.to_dict() for item in windows],
        "mismatch_examples": mismatch_examples,
        "parity_policy": parity_policy,
        "published": published,
    }


__all__ = ["build_trade_bar_compatibility"]
