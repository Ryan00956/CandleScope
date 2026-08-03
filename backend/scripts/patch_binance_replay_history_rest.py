"""Patch exact immutable replay-history gaps from Binance's Spot REST API.

This is intentionally narrower than the Binance Vision importer.  It may only
probe gaps declared by one pinned catalog revision plus an explicitly pinned
trailing end-open, and it may publish patch objects only outside existing
object bounds.  Every exact K-line or exchange-confirmed empty JSON response
and UTC receipt is persisted before any content-addressed BAR object and
replacement catalog pointer are published.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Mapping, Sequence
from urllib.parse import urlencode


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.data_engine.backfill.archive_cache import (  # noqa: E402
    AiohttpArchiveHttpClient,
)
from app.data_engine.interval_policy import (  # noqa: E402
    IntervalSpec,
    parse_interval_spec,
)
from app.exchanges.archive import ArchiveDataError  # noqa: E402
from app.replay.canonical import canonical_json_bytes  # noqa: E402
from app.replay.catalog import ReplaySeriesIdentity  # noqa: E402
from app.replay.history_archive import (  # noqa: E402
    ReplayHistoryArchiveError,
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
    ReplayHistoryCatalogManifest,
    ReplayHistoryObject,
    ReplayHistoryRepository,
)
from app.replay.remote_history import (  # noqa: E402
    publish_catalog_and_remote_index_if_current,
)


_HOST = "api.binance.com"
_ORIGIN = f"https://{_HOST}"
_PATH = "/api/v3/klines"
_MAX_RESPONSE_BYTES = 64 * 1024
_RECEIPT_SCHEMA = "replay-history-rest-receipt.v1"
_RAW_SOURCE_SCHEMA = "binance-rest-kline-response.v1"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Probe exact gaps in one pinned Binance Spot replay-history catalog "
            "using one /api/v3/klines request per missing bucket."
        )
    )
    parser.add_argument("--archive-dir", required=True, type=Path)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--interval", required=True)
    parser.add_argument("--base-revision", required=True)
    parser.add_argument("--expected-gap-count", required=True, type=int)
    parser.add_argument("--expected-missing-bars", type=int)
    parser.add_argument(
        "--required-end-open-ms",
        type=int,
        help=(
            "Optionally extend exact probing through this pinned bucket open; "
            "trailing opens after the catalog tail count as one additional gap."
        ),
    )
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    return parser


def _proxy() -> str | None:
    return (
        os.getenv("INGESTION_HTTP_PROXY")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or None
    )


def _interval_spec(interval: str) -> IntervalSpec:
    spec = parse_interval_spec(interval)
    if spec is None:
        raise ReplayHistoryArchiveError("REST patch interval is invalid")
    return spec


def _bucket_end_ms(open_time_ms: int, interval: str) -> int:
    next_open_ms = _interval_spec(interval).next_ms(open_time_ms)
    if next_open_ms <= open_time_ms:
        raise ReplayHistoryArchiveError("REST patch interval bounds are invalid")
    return next_open_ms - 1


def _request_url(symbol: str, interval: str, open_time_ms: int) -> str:
    query = urlencode(
        (
            ("symbol", str(symbol).strip().upper()),
            ("interval", interval),
            ("startTime", str(open_time_ms)),
            ("endTime", str(_bucket_end_ms(open_time_ms, interval))),
            ("limit", "1"),
        )
    )
    return f"{_ORIGIN}{_PATH}?{query}"


def _decimal(value: object, field_name: str, *, positive: bool = False) -> str:
    if isinstance(value, bool):
        raise ReplayHistoryArchiveError(f"REST {field_name} is invalid")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ReplayHistoryArchiveError(f"REST {field_name} is invalid") from exc
    if not parsed.is_finite() or parsed < 0 or (positive and parsed <= 0):
        raise ReplayHistoryArchiveError(f"REST {field_name} is outside bounds")
    return format(parsed, "f")


def _parse_exact_response(
    body: bytes,
    *,
    expected_open_ms: int,
    interval: str,
) -> dict[str, object] | None:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReplayHistoryArchiveError("Binance REST response is not JSON") from exc
    if payload == []:
        return None
    if not isinstance(payload, list) or len(payload) != 1:
        raise ReplayHistoryArchiveError(
            "Binance REST response must be empty or contain exactly one K-line"
        )
    row = payload[0]
    if not isinstance(row, list) or len(row) != 12:
        raise ReplayHistoryArchiveError("Binance REST K-line schema is incompatible")
    try:
        open_time = int(row[0])
        close_time = int(row[6])
        trades = int(row[8])
    except (TypeError, ValueError) as exc:
        raise ReplayHistoryArchiveError(
            "Binance REST K-line bounds are invalid"
        ) from exc
    canonical_close_time = _bucket_end_ms(expected_open_ms, interval)
    normalized_close_boundary = (
        expected_open_ms <= close_time < canonical_close_time
    )
    if open_time != expected_open_ms or trades < 0:
        raise ReplayHistoryArchiveError(
            "Binance REST K-line does not match the exact requested bucket"
        )
    if normalized_close_boundary:
        close_time = canonical_close_time
    elif close_time != canonical_close_time:
        raise ReplayHistoryArchiveError(
            "Binance REST K-line does not match the exact requested bucket"
        )
    open_price = _decimal(row[1], "open", positive=True)
    high = _decimal(row[2], "high", positive=True)
    low = _decimal(row[3], "low", positive=True)
    close = _decimal(row[4], "close", positive=True)
    if Decimal(high) < max(Decimal(open_price), Decimal(close)):
        raise ReplayHistoryArchiveError("Binance REST high is inconsistent")
    if Decimal(low) > min(Decimal(open_price), Decimal(close)):
        raise ReplayHistoryArchiveError("Binance REST low is inconsistent")
    if Decimal(low) > Decimal(high):
        raise ReplayHistoryArchiveError("Binance REST price range is inconsistent")
    return {
        "open_time": open_time,
        "close_time": close_time,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": _decimal(row[5], "volume"),
        "quote_volume": _decimal(row[7], "quote_volume"),
        "trades": trades,
        "taker_buy_base": _decimal(row[9], "taker_buy_base"),
        "taker_buy_quote": _decimal(row[10], "taker_buy_quote"),
        "source": (
            "binance_rest_api_exact_close_boundary_normalized"
            if normalized_close_boundary
            else "binance_rest_api_exact"
        ),
    }


def _parse_exact_bar(
    body: bytes,
    *,
    expected_open_ms: int,
    interval: str,
) -> dict[str, object]:
    """Backward-compatible strict parser used by existing singleton callers."""

    bar = _parse_exact_response(
        body,
        expected_open_ms=expected_open_ms,
        interval=interval,
    )
    if bar is None:
        raise ReplayHistoryArchiveError(
            "Binance REST response must contain exactly one K-line"
        )
    return bar


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        if path.read_bytes() != payload:
            raise ReplayHistoryArchiveError("immutable REST source receipt changed")
        return
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _persist_source_receipt(
    archive_dir: Path,
    *,
    request_url: str,
    body: bytes,
    received_at_ms: int,
    open_time_ms: int,
    interval: str,
    status: int,
    content_type: str,
) -> tuple[str, str, str]:
    response_digest = f"sha256:{hashlib.sha256(body).hexdigest()}"
    response_token = response_digest.removeprefix("sha256:")
    response_path = (
        archive_dir
        / "source-responses"
        / "binance_rest_api"
        / "sha256"
        / response_token[:2]
        / f"{response_token}.json"
    )
    _atomic_write(response_path, body)
    receipt = {
        "schema_version": _RECEIPT_SCHEMA,
        "source_schema": _RAW_SOURCE_SCHEMA,
        "source_provider": "binance_rest_api",
        "request_url": request_url,
        "http_status": status,
        "content_type": content_type,
        "received_at_ms": received_at_ms,
        "received_at_utc": datetime.fromtimestamp(
            received_at_ms / 1_000,
            tz=timezone.utc,
        ).isoformat().replace("+00:00", "Z"),
        "interval": interval,
        "open_time_ms": open_time_ms,
        "response_content_sha256": response_digest,
        "response_size_bytes": len(body),
        "response_path": response_path.relative_to(archive_dir).as_posix(),
    }
    receipt_bytes = canonical_json_bytes(receipt)
    receipt_digest = f"sha256:{hashlib.sha256(receipt_bytes).hexdigest()}"
    receipt_token = receipt_digest.removeprefix("sha256:")
    receipt_path = (
        archive_dir
        / "source-receipts"
        / "binance_rest_api"
        / "sha256"
        / receipt_token[:2]
        / f"{receipt_token}.json"
    )
    _atomic_write(receipt_path, receipt_bytes)
    return response_digest, receipt_digest, receipt_path.relative_to(
        archive_dir
    ).as_posix()


def _enumerate_gap_opens(
    *,
    start_ms: int,
    end_ms: int,
    interval: str,
    declared_missing_bars: int,
) -> tuple[int, ...]:
    if start_ms > end_ms or declared_missing_bars < 1:
        raise ReplayHistoryArchiveError("gap evidence bounds/count are invalid")
    spec = _interval_spec(interval)
    opens: list[int] = []
    cursor = start_ms
    while cursor <= end_ms:
        opens.append(cursor)
        if len(opens) > declared_missing_bars:
            raise ReplayHistoryArchiveError(
                "gap evidence count does not match interval bounds"
            )
        next_open_ms = spec.next_ms(cursor)
        if next_open_ms <= cursor:
            raise ReplayHistoryArchiveError("gap interval does not advance")
        cursor = next_open_ms
    if opens[-1] != end_ms or len(opens) != declared_missing_bars:
        raise ReplayHistoryArchiveError(
            "gap evidence count does not match interval bounds"
        )
    return tuple(opens)


def _opens_from_gap_scan(
    gaps: Mapping[str, object],
    *,
    interval: str,
    require_singletons: bool = False,
) -> tuple[int, ...]:
    raw = gaps.get("gaps", ())
    if not isinstance(raw, (list, tuple)):
        raise ReplayHistoryArchiveError("gap evidence is invalid")
    opens: list[int] = []
    for item in raw:
        if not isinstance(item, Mapping):
            raise ReplayHistoryArchiveError("gap evidence is invalid")
        start_ms = int(item["start_ms"])
        end_ms = int(item["end_ms"])
        declared_missing_bars = int(item.get("missing_bars", 0))
        if require_singletons and (
            start_ms != end_ms or declared_missing_bars != 1
        ):
            raise ReplayHistoryArchiveError(
                "legacy REST patch mode may fill singleton gaps only; pass "
                "--expected-missing-bars to opt in to multi-bar probing"
            )
        opens.extend(
            _enumerate_gap_opens(
                start_ms=start_ms,
                end_ms=end_ms,
                interval=interval,
                declared_missing_bars=declared_missing_bars,
            )
        )
    actual_missing_bars = int(gaps.get("missing_bars", -1))
    if len(opens) != actual_missing_bars or len(set(opens)) != len(opens):
        raise ReplayHistoryArchiveError("gap evidence contains duplicate/missing opens")
    return tuple(sorted(opens))


def _missing_opens(
    repository: ReplayHistoryRepository,
    *,
    revision: str,
    symbol: str,
    interval: str,
    expected_gap_count: int,
    expected_missing_bars: int | None,
    required_end_open_ms: int | None = None,
) -> tuple[int, ...]:
    bounds = repository.get_bounds_at_revision(
        revision,
        symbol,
        interval,
        exchange="binance",
        market_type="spot",
    )
    latest_open_ms = int(bounds["latest_open_time"])
    scan_end_ms = latest_open_ms
    if required_end_open_ms is not None:
        scan_end_ms = int(required_end_open_ms)
        if scan_end_ms < latest_open_ms:
            raise ReplayHistoryArchiveError(
                "--required-end-open-ms precedes the pinned catalog tail"
            )
        cursor = latest_open_ms
        spec = _interval_spec(interval)
        while cursor < scan_end_ms:
            next_open_ms = spec.next_ms(cursor)
            if next_open_ms <= cursor or next_open_ms > scan_end_ms:
                raise ReplayHistoryArchiveError(
                    "--required-end-open-ms is not on the pinned catalog grid"
                )
            cursor = next_open_ms
    gaps = repository.scan_gaps_at_revision(
        revision,
        symbol,
        interval,
        start_ms=int(bounds["earliest_open_time"]),
        end_ms=scan_end_ms,
        exchange="binance",
        market_type="spot",
        limit=max(1, expected_gap_count + 1),
    )
    raw = gaps.get("gaps", ())
    if not isinstance(raw, (list, tuple)):
        raise ReplayHistoryArchiveError("gap evidence is invalid")
    actual_missing_bars = int(gaps.get("missing_bars", -1))
    required_missing_bars = (
        expected_gap_count
        if expected_missing_bars is None
        else expected_missing_bars
    )
    if (
        gaps.get("truncated") is not False
        or int(gaps.get("gap_count", -1)) != expected_gap_count
        or actual_missing_bars != required_missing_bars
        or len(raw) != expected_gap_count
    ):
        raise ReplayHistoryArchiveError(
            "pinned catalog does not contain the exact expected gaps/missing bars"
        )
    return _opens_from_gap_scan(
        gaps,
        interval=interval,
        require_singletons=expected_missing_bars is None,
    )


def _singleton_gaps(
    repository: ReplayHistoryRepository,
    *,
    revision: str,
    symbol: str,
    interval: str,
    expected_count: int,
) -> tuple[int, ...]:
    """Backward-compatible wrapper for the original singleton contract."""

    return _missing_opens(
        repository,
        revision=revision,
        symbol=symbol,
        interval=interval,
        expected_gap_count=expected_count,
        expected_missing_bars=None,
        required_end_open_ms=None,
    )


def _gap_placement_blocker(
    manifest: ReplayHistoryCatalogManifest,
    missing_opens: Sequence[int],
) -> dict[str, object] | None:
    blocked_by_object: list[dict[str, object]] = []
    blocked_count = 0
    for item in manifest.objects:
        covered = tuple(
            open_ms
            for open_ms in missing_opens
            if item.first_open_ms <= open_ms <= item.last_open_ms
        )
        if not covered:
            continue
        blocked_count += len(covered)
        blocked_by_object.append(
            {
                "object_sha256": item.object_sha256,
                "source_object_key": item.source_object_key,
                "object_first_open_ms": item.first_open_ms,
                "object_last_open_ms": item.last_open_ms,
                "blocked_missing_bars": len(covered),
                "first_blocked_open_ms": covered[0],
                "last_blocked_open_ms": covered[-1],
            }
        )
    if not blocked_by_object:
        return None
    return {
        "schema_version": "replay-history-rest-patch-blocker.v1",
        "blocker": "gap_inside_existing_object_bounds",
        "base_revision": manifest.catalog_epoch,
        "interval": manifest.interval,
        "blocked_missing_bars": blocked_count,
        "safe_missing_bars": len(missing_opens) - blocked_count,
        "blocked_objects": blocked_by_object,
        "required_remediation": (
            "Rebuild each containing object from its checksum-verified source plus "
            "exact REST receipts, bind the replacement to the pinned base revision "
            "and original object hashes, then atomically replace the whole object."
        ),
    }


def _assert_safe_gap_placement(
    manifest: ReplayHistoryCatalogManifest,
    missing_opens: Sequence[int],
) -> None:
    blocker = _gap_placement_blocker(manifest, missing_opens)
    if blocker is not None:
        raise ReplayHistoryArchiveError(
            "REST patch blocked: "
            + json.dumps(blocker, ensure_ascii=False, sort_keys=True)
        )


def _publish_pinned_batches(
    writer: ReplayHistoryArchiveWriter,
    *,
    identity: ReplaySeriesIdentity,
    interval: str,
    base_revision: str,
    batches: Sequence[ReplayHistoryImportBatch],
    listing_boundary_source: str,
    source_bucket_anchor_ms: int,
    alignment_policy: str,
) -> tuple[ReplayHistoryCatalogManifest, tuple[ReplayHistoryObject, ...]]:
    """Publish one revision-pinned catalog and matching remote index."""

    objects = tuple(
        writer.write_object(identity, interval, batch) for batch in batches
    )
    manifest, _index = publish_catalog_and_remote_index_if_current(
        writer,
        base_revision,
        identity,
        interval,
        objects,
        merge_current=True,
        listing_boundary_source=listing_boundary_source,
        source_bucket_anchor_ms=source_bucket_anchor_ms,
        alignment_policy=alignment_policy,
    )
    return manifest, objects


async def patch_history(args: argparse.Namespace) -> dict[str, object]:
    if isinstance(args.expected_gap_count, bool) or args.expected_gap_count < 1:
        raise ReplayHistoryArchiveError("--expected-gap-count must be positive")
    expected_missing_bars = getattr(args, "expected_missing_bars", None)
    if expected_missing_bars is not None and (
        isinstance(expected_missing_bars, bool) or expected_missing_bars < 1
    ):
        raise ReplayHistoryArchiveError(
            "--expected-missing-bars must be positive when supplied"
        )
    required_end_open_ms = getattr(args, "required_end_open_ms", None)
    if required_end_open_ms is not None and (
        isinstance(required_end_open_ms, bool) or required_end_open_ms < 0
    ):
        raise ReplayHistoryArchiveError(
            "--required-end-open-ms must be a non-negative timestamp"
        )
    if args.timeout_seconds < 1:
        raise ReplayHistoryArchiveError("--timeout-seconds must be at least 1")
    archive_dir = args.archive_dir.expanduser().resolve()
    symbol = str(args.symbol).strip().upper()
    interval = str(args.interval).strip()
    identity = ReplaySeriesIdentity("binance", "spot", symbol)
    writer = ReplayHistoryArchiveWriter(archive_dir)
    current = writer.current_manifest(identity, interval)
    if current is None or current.catalog_epoch != args.base_revision:
        raise ReplayHistoryArchiveError(
            "current catalog does not match --base-revision"
        )
    repository = ReplayHistoryRepository(archive_dir)
    gap_opens = _missing_opens(
        repository,
        revision=args.base_revision,
        symbol=symbol,
        interval=interval,
        expected_gap_count=args.expected_gap_count,
        expected_missing_bars=expected_missing_bars,
        required_end_open_ms=required_end_open_ms,
    )
    _assert_safe_gap_placement(current, gap_opens)
    http = AiohttpArchiveHttpClient(
        timeout_seconds=args.timeout_seconds,
        proxy_resolver=_proxy,
    )
    pending_exact: list[dict[str, object]] = []
    confirmed_empty: list[dict[str, object]] = []
    for open_time_ms in gap_opens:
        url = _request_url(symbol, interval, open_time_ms)
        response = await http.get_bytes(
            url,
            allowed_hosts=(_HOST,),
            max_bytes=_MAX_RESPONSE_BYTES,
        )
        received_at_ms = int(time.time() * 1_000)
        if response.status != 200:
            raise ArchiveDataError(
                f"Binance REST exact K-line returned HTTP {response.status}"
            )
        content_type = str(response.headers.get("content-type", ""))
        if "json" not in content_type.lower():
            raise ReplayHistoryArchiveError(
                "Binance REST response content type is not JSON"
            )
        bar = _parse_exact_response(
            response.body,
            expected_open_ms=open_time_ms,
            interval=interval,
        )
        response_digest, receipt_digest, receipt_path = _persist_source_receipt(
            archive_dir,
            request_url=url,
            body=response.body,
            received_at_ms=received_at_ms,
            open_time_ms=open_time_ms,
            interval=interval,
            status=response.status,
            content_type=content_type,
        )
        evidence = {
            "open_time_ms": open_time_ms,
            "response_content_sha256": response_digest,
            "receipt_sha256": receipt_digest,
            "receipt_path": receipt_path,
            "request_url": url,
        }
        if bar is None:
            confirmed_empty.append(
                {
                    **evidence,
                    "status": "exchange_confirmed_true_gap",
                }
            )
            continue
        object_key = (
            "binance-rest-kline-v1:binance:spot:"
            f"{symbol}:{interval}:{open_time_ms}:"
            f"{receipt_digest.removeprefix('sha256:')}"
        )
        pending_exact.append(
            {
                "evidence": evidence,
                "batch": ReplayHistoryImportBatch(
                    rows=(bar,),
                    source_provider="binance_rest_api",
                    source_object_key=object_key,
                    source_period=str(open_time_ms),
                    source_url=url,
                    source_content_sha256=response_digest,
                    source_provider_checksum=None,
                    source_row_count=1,
                    source_rejected_rows=0,
                    source_normalized_rows=int(
                        str(bar["source"]).endswith("_normalized")
                    ),
                    source_filter_policy=(
                        "binance_rest_exact_identity_bounds_receipt_v1"
                    ),
                    source_bucket_anchor_ms=current.source_bucket_anchor_ms,
                    alignment_policy=current.alignment_policy,
                ),
            }
        )
    manifest, objects = await asyncio.to_thread(
        _publish_pinned_batches,
        writer,
        identity=identity,
        interval=interval,
        base_revision=args.base_revision,
        batches=tuple(item["batch"] for item in pending_exact),
        listing_boundary_source=current.listing_boundary_source,
        source_bucket_anchor_ms=current.source_bucket_anchor_ms,
        alignment_policy=current.alignment_policy,
    )
    imported = [
        {
            **dict(pending["evidence"]),
            "object_sha256": item.object_sha256,
        }
        for pending, item in zip(pending_exact, objects, strict=True)
    ]
    verified = ReplayHistoryRepository(archive_dir)
    post = verified.scan_gaps_at_revision(
        manifest.catalog_epoch,
        symbol,
        interval,
        start_ms=manifest.earliest_open_ms,
        end_ms=(
            manifest.latest_open_ms
            if required_end_open_ms is None
            else required_end_open_ms
        ),
        exchange="binance",
        market_type="spot",
        limit=max(1, len(confirmed_empty) + 1),
    )
    remaining_opens = _opens_from_gap_scan(post, interval=interval)
    confirmed_empty_opens = tuple(
        sorted(int(item["open_time_ms"]) for item in confirmed_empty)
    )
    object_audit = verified.verify_catalog_objects(
        symbol,
        interval,
        exchange="binance",
        market_type="spot",
        source_revision=manifest.catalog_epoch,
    )
    if (
        remaining_opens != confirmed_empty_opens
        or object_audit.get("verified") is not True
    ):
        raise ReplayHistoryArchiveError("published REST patch catalog failed audit")
    return {
        "schema_version": "replay-history-rest-patch-report.v1",
        "source_provider": "binance_rest_api",
        "base_revision": args.base_revision,
        "catalog_epoch": manifest.catalog_epoch,
        "interval": interval,
        "required_end_open_ms": required_end_open_ms,
        "probed_count": len(gap_opens),
        "patched_count": len(imported),
        "exchange_confirmed_true_gap_count": len(confirmed_empty),
        "total_count": manifest.total_count,
        "gap_count": post["gap_count"],
        "missing_bars": post["missing_bars"],
        "objects_verified": object_audit["verified_objects"],
        "verified_bytes": object_audit["verified_bytes"],
        "imported": imported,
        "exchange_confirmed_true_gaps": confirmed_empty,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        report = asyncio.run(patch_history(args))
    except (ArchiveDataError, ReplayHistoryArchiveError, OSError) as exc:
        parser.exit(2, f"patch_binance_replay_history_rest: error: {exc}\n")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
