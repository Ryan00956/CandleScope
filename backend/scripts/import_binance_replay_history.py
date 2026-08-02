"""Build a checksum-bound replay-history catalog from Binance Vision K-lines."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.data_engine.backfill.archive_cache import (  # noqa: E402
    AiohttpArchiveHttpClient,
    HistoricalArchiveCache,
)
from app.data_engine.interval_policy import parse_interval_ms  # noqa: E402
from app.exchanges.archive import (  # noqa: E402
    ArchiveDataError,
    ArchiveGranularity,
    ArchiveObjectRef,
)
from app.exchanges.plugins.binance.archive import (  # noqa: E402
    BinanceKlineArchiveProvider,
)
from app.replay.catalog import ReplaySeriesIdentity  # noqa: E402
from app.replay.history_archive import (  # noqa: E402
    ReplayHistoryArchiveError,
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
    SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
    SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
)


def _date(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("date must use canonical YYYY-MM-DD")
    return parsed


def _start_ms(value: date) -> int:
    return int(
        datetime(
            value.year,
            value.month,
            value.day,
            tzinfo=timezone.utc,
        ).timestamp()
        * 1_000
    )


def _end_ms(value: date) -> int:
    return _start_ms(value + timedelta(days=1)) - 1


def _proxy() -> str | None:
    return (
        os.getenv("INGESTION_HTTP_PROXY")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or None
    )


def _progress(event: str, **fields: object) -> None:
    print(
        json.dumps(
            {"event": event, **fields},
            ensure_ascii=False,
            sort_keys=True,
        ),
        file=sys.stderr,
        flush=True,
    )


def build_parser() -> argparse.ArgumentParser:
    yesterday = datetime.now(tz=timezone.utc).date() - timedelta(days=1)
    parser = argparse.ArgumentParser(
        description=(
            "Download checksum-verified Binance K-line archives, convert each "
            "source object to immutable Parquet, and atomically publish a "
            "manifest-indexed replay-history catalog."
        )
    )
    parser.add_argument("--market-type", required=True, choices=("spot", "futures"))
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--start", type=_date, default=date(2017, 7, 1))
    parser.add_argument("--end", type=_date, default=yesterday)
    parser.add_argument("--archive-dir", required=True, type=Path)
    parser.add_argument("--source-cache-dir", type=Path)
    parser.add_argument("--cache-max-bytes", type=int, default=20 * 1024**3)
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    parser.add_argument(
        "--fail-on-missing",
        action="store_true",
        help=(
            "Fail on HTTP 404. By default absent pre-listing/source objects are "
            "recorded in the report and become explicit catalog discontinuities."
        ),
    )
    parser.add_argument(
        "--replace-current",
        action="store_true",
        help="Publish only this invocation's objects instead of merging current.",
    )
    parser.add_argument(
        "--plan-only",
        action="store_true",
        help="Print the selected official source objects without downloading.",
    )
    return parser


def _select_source_objects(refs) -> list:
    """Prefer one closed monthly object, plus daily objects for the open month."""

    monthly = [item for item in refs if item.granularity is ArchiveGranularity.MONTHLY]
    covered_months = {item.period for item in monthly}
    daily = [
        item
        for item in refs
        if item.granularity is ArchiveGranularity.DAILY
        and item.period[:7] not in covered_months
    ]
    return sorted(
        [*monthly, *daily],
        key=lambda item: (item.start_ms, item.end_ms, item.object_key),
    )


def _daily_fallbacks_by_month(
    refs: Sequence[ArchiveObjectRef],
) -> dict[str, tuple[ArchiveObjectRef, ...]]:
    fallbacks: dict[str, list[ArchiveObjectRef]] = {}
    for ref in refs:
        if ref.granularity is ArchiveGranularity.DAILY:
            fallbacks.setdefault(ref.period[:7], []).append(ref)
    return {
        month: tuple(
            sorted(items, key=lambda item: (item.start_ms, item.object_key))
        )
        for month, items in fallbacks.items()
    }


async def import_history(args: argparse.Namespace) -> dict[str, object]:
    if args.start > args.end:
        raise ReplayHistoryArchiveError("--start must not be after --end")
    if args.cache_max_bytes < 1:
        raise ReplayHistoryArchiveError("--cache-max-bytes must be positive")
    if args.timeout_seconds < 1:
        raise ReplayHistoryArchiveError("--timeout-seconds must be at least 1")

    now_ms = int(time.time() * 1_000)
    provider = BinanceKlineArchiveProvider()
    planned_refs = provider.plan_objects(
        market_type=args.market_type,
        symbol=args.symbol,
        interval=args.interval,
        start_ms=_start_ms(args.start),
        end_ms=_end_ms(args.end),
        now_ms=now_ms,
    )
    refs = _select_source_objects(planned_refs)
    daily_fallbacks = _daily_fallbacks_by_month(planned_refs)
    plan = [
        {
            "object_key": item.object_key,
            "granularity": item.granularity.value,
            "period": item.period,
            "url": item.url,
        }
        for item in refs
    ]
    if args.plan_only:
        return {
            "schema_version": "replay-history-import-report.v1",
            "published": False,
            "plan_only": True,
            "source_object_count": len(refs),
            "daily_fallback_candidate_count": sum(
                len(items) for items in daily_fallbacks.values()
            ),
            "objects": plan,
        }
    if not refs:
        raise ReplayHistoryArchiveError(
            "Binance provider planned no compatible source objects"
        )

    archive_dir = args.archive_dir.expanduser().resolve()
    cache_dir = (
        args.source_cache_dir.expanduser().resolve()
        if args.source_cache_dir is not None
        else archive_dir.parent / f"{archive_dir.name}-source-cache"
    )
    writer = ReplayHistoryArchiveWriter(archive_dir)
    identity = ReplaySeriesIdentity(
        "binance",
        args.market_type,
        str(args.symbol).strip().upper(),
    )
    current = writer.current_manifest(identity, args.interval)
    alignment_policy = (
        SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED
        if args.interval == "3d"
        else (
            SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH
            if args.interval == "1M"
            else None
        )
    )
    source_bucket_anchor_ms = (
        current.source_bucket_anchor_ms
        if current is not None
        and alignment_policy is not None
        and current.alignment_policy == alignment_policy
        else None
    )
    current_by_source = (
        {item.source_object_key: item for item in current.objects}
        if current is not None
        else {}
    )
    cache = HistoricalArchiveCache(
        cache_dir,
        max_bytes=args.cache_max_bytes,
    )
    http = AiohttpArchiveHttpClient(
        timeout_seconds=args.timeout_seconds,
        proxy_resolver=_proxy,
    )

    imported = []
    reused = []
    missing = []
    objects = []
    scheduled_keys = {item.object_key for item in refs}
    index = 0
    while index < len(refs):
        ref = refs[index]
        index += 1
        _progress(
            "source_object_started",
            position=index,
            total=len(refs),
            period=ref.period,
            object_key=ref.object_key,
        )
        try:
            async with cache.materialize(ref, provider, http) as cached:
                if cached.provider_checksum is None:
                    raise ReplayHistoryArchiveError(
                        "Binance replay history requires an official checksum"
                    )
                content_digest = f"sha256:{cached.content_sha256}"
                checksum_digest = f"sha256:{cached.provider_checksum}"
                existing = current_by_source.get(ref.object_key)
                if (
                    existing is not None
                    and existing.source_content_sha256 == content_digest
                    and existing.source_provider_checksum == checksum_digest
                ):
                    objects.append(existing)
                    reused.append(ref.object_key)
                    _progress(
                        "source_object_reused",
                        position=index,
                        total=len(refs),
                        period=ref.period,
                        rows=existing.row_count,
                    )
                    continue
                parsed = await asyncio.to_thread(
                    provider.parse_bars_for_replay,
                    cached.path,
                    ref,
                )
                if (
                    alignment_policy == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED
                    and source_bucket_anchor_ms is None
                ):
                    interval_ms = parse_interval_ms(args.interval)
                    if interval_ms is None:
                        raise ReplayHistoryArchiveError(
                            "Binance source interval is invalid"
                        )
                    source_bucket_anchor_ms = (
                        int(parsed.bars[0].open_time) % interval_ms
                    )
                item = await asyncio.to_thread(
                    writer.write_object,
                    identity,
                    args.interval,
                    ReplayHistoryImportBatch(
                        rows=parsed.bars,
                        source_provider=ref.provider_id,
                        source_object_key=ref.object_key,
                        source_period=ref.period,
                        source_url=ref.url,
                        source_content_sha256=content_digest,
                        source_provider_checksum=checksum_digest,
                        source_row_count=parsed.source_row_count,
                        source_rejected_rows=parsed.rejected_row_count,
                        source_normalized_rows=parsed.normalized_row_count,
                        source_filter_policy=(
                            "binance_checksum_catalog_fixed_grid_v1"
                            if alignment_policy
                            == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED
                            else (
                                "binance_checksum_calendar_month_grid_v1"
                                if alignment_policy
                                == SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH
                                else "binance_checksum_utc_grid_v1"
                            )
                        ),
                        source_rejection_reasons=parsed.rejection_reasons,
                        source_bucket_anchor_ms=source_bucket_anchor_ms,
                        alignment_policy=alignment_policy,
                    ),
                )
                objects.append(item)
                imported.append(
                    {
                        "object_key": ref.object_key,
                        "period": ref.period,
                        "rows": item.row_count,
                        "source_rows": item.source_row_count,
                        "rejected_rows": item.source_rejected_rows,
                        "normalized_rows": item.source_normalized_rows,
                        "rejection_reasons": dict(
                            item.source_rejection_reasons
                        ),
                        "object_sha256": item.object_sha256,
                        "position": index,
                        "total": len(refs),
                    }
                )
                _progress(
                    "source_object_imported",
                    position=index,
                    total=len(refs),
                    period=ref.period,
                    rows=item.row_count,
                    rejected_rows=item.source_rejected_rows,
                    normalized_rows=item.source_normalized_rows,
                )
        except ArchiveDataError as exc:
            message = str(exc)
            if "HTTP 404" not in message or args.fail_on_missing:
                raise
            missing.append(
                {
                    "object_key": ref.object_key,
                    "period": ref.period,
                    "reason": message,
                }
            )
            _progress(
                "source_object_missing",
                position=index,
                total=len(refs),
                period=ref.period,
                reason=message,
            )
            if ref.granularity is ArchiveGranularity.MONTHLY:
                fallback_refs = tuple(
                    item
                    for item in daily_fallbacks.get(ref.period, ())
                    if item.object_key not in scheduled_keys
                )
                if fallback_refs:
                    refs[index:index] = fallback_refs
                    scheduled_keys.update(
                        item.object_key for item in fallback_refs
                    )
                    _progress(
                        "source_object_daily_fallback_scheduled",
                        monthly_period=ref.period,
                        daily_object_count=len(fallback_refs),
                        total=len(refs),
                    )

    manifest = await asyncio.to_thread(
        writer.publish_catalog,
        identity,
        args.interval,
        objects,
        merge_current=not args.replace_current,
        listing_boundary_source="first_checksum_verified_binance_archive_bar",
        source_bucket_anchor_ms=source_bucket_anchor_ms,
        alignment_policy=alignment_policy,
    )
    return {
        "schema_version": "replay-history-import-report.v1",
        "published": True,
        "plan_only": False,
        "identity": identity.to_dict(),
        "interval": args.interval,
        "requested_start": args.start.isoformat(),
        "requested_end": args.end.isoformat(),
        "catalog_epoch": manifest.catalog_epoch,
        "earliest_open_ms": manifest.earliest_open_ms,
        "latest_open_ms": manifest.latest_open_ms,
        "total_count": manifest.total_count,
        "continuous_segments": len(manifest.segments),
        "source_object_count": len(refs),
        "imported_count": len(imported),
        "reused_count": len(reused),
        "missing_count": len(missing),
        "imported": imported,
        "reused": reused,
        "missing": missing,
        "archive_dir": str(archive_dir),
        "source_cache_dir": str(cache_dir),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        report = asyncio.run(import_history(args))
    except (ArchiveDataError, ReplayHistoryArchiveError, OSError) as exc:
        parser.exit(2, f"import_binance_replay_history: error: {exc}\n")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
